import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { connectionExecutor } from "@/utils/mcp/provider-connection";
import {
  AppToolError,
  ConnectionExpiredError,
} from "@/utils/mcp/providers/types";

vi.mock("@/utils/prisma");
const { mockExecuteTool, mockCheckConnection } = vi.hoisted(() => ({
  mockExecuteTool: vi.fn(),
  mockCheckConnection: vi.fn(),
}));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({
    executeTool: mockExecuteTool,
    checkConnection: mockCheckConnection,
  }),
}));

// Canvas answers a token it accepts, asking for something it may not see,
// with a 401 too.
const CANVAS_RESOURCE_401 =
  'CANVAS_LIST_CALENDAR_EVENTS_FOR_USER failed: {"status":"unauthorized","errors":[{"message":"user not authorized to perform that action"}]}';

describe("connectionExecutor", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpConnection.updateMany.mockResolvedValue({ count: 1 });
  });

  const canvas = () =>
    connectionExecutor({
      id: "connection-canvas",
      integrationName: "canvas",
      emailAccountId: "school",
    })!;

  it("doesn't mark Canvas for reconnecting when only one resource is off limits", async () => {
    mockExecuteTool.mockRejectedValue(
      new ConnectionExpiredError("canvas", CANVAS_RESOURCE_401),
    );
    mockCheckConnection.mockResolvedValue({ response_data: { id: 1 } });

    const call = canvas()("CANVAS_LIST_CALENDAR_EVENTS_FOR_USER", {});

    await expect(call).rejects.toBeInstanceOf(AppToolError);
    expect(mockCheckConnection).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "CANVAS_GET_CURRENT_USER" }),
    );
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
  });

  it("marks Canvas for reconnecting when the token itself is turned away", async () => {
    mockExecuteTool.mockRejectedValue(
      new ConnectionExpiredError("canvas", CANVAS_RESOURCE_401),
    );
    mockCheckConnection.mockRejectedValue(
      new ConnectionExpiredError(
        "canvas",
        'CANVAS_GET_CURRENT_USER failed: {"errors":[{"message":"Invalid access token."}]}',
      ),
    );

    await expect(canvas()("CANVAS_LIST_COURSES", {})).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
      where: {
        id: "connection-canvas",
        needsReconnectAt: null,
        updatedAt: { lt: expect.any(Date) },
      },
      data: { needsReconnectAt: expect.any(Date) },
    });
  });

  it("doesn't mark the connection when the re-check can't reach the app", async () => {
    mockExecuteTool.mockRejectedValue(
      new ConnectionExpiredError("canvas", CANVAS_RESOURCE_401),
    );
    mockCheckConnection.mockRejectedValue(new Error("fetch failed"));

    await expect(canvas()("CANVAS_LIST_COURSES", {})).rejects.toBeInstanceOf(
      AppToolError,
    );
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
  });

  it("doesn't mark an app it can't re-check over an error that only looks like an auth failure", async () => {
    mockExecuteTool.mockRejectedValue(
      new ConnectionExpiredError(
        "slack",
        "SLACK_SEARCH_MESSAGES failed: 401 not_in_channel",
      ),
    );

    const slack = connectionExecutor({
      id: "connection-slack",
      integrationName: "slack",
      emailAccountId: "school",
    })!;

    await expect(slack("SLACK_SEARCH_MESSAGES", {})).rejects.toBeInstanceOf(
      AppToolError,
    );
    expect(mockCheckConnection).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
  });

  it("marks any app whose provider no longer holds an authorization", async () => {
    mockExecuteTool.mockRejectedValue(
      new ConnectionExpiredError("slack", "No active slack connection", {
        confirmed: true,
      }),
    );

    const slack = connectionExecutor({
      id: "connection-slack",
      integrationName: "slack",
      emailAccountId: "school",
    })!;

    await expect(slack("SLACK_SEARCH_MESSAGES", {})).rejects.toBeInstanceOf(
      ConnectionExpiredError,
    );
    expect(mockCheckConnection).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalled();
  });

  it("doesn't let a call started before a reconnect mark the new connection", async () => {
    let fail: (error: unknown) => void = () => {};
    mockExecuteTool.mockReturnValue(
      new Promise((_, reject) => {
        fail = reject;
      }),
    );
    mockCheckConnection.mockRejectedValue(
      new ConnectionExpiredError("canvas", "Invalid access token."),
    );

    const call = canvas()("CANVAS_LIST_COURSES", {});
    const startedBy = new Date();
    fail(new ConnectionExpiredError("canvas", "Invalid access token."));
    await expect(call).rejects.toThrow();

    const where = prisma.mcpConnection.updateMany.mock.calls[0][0].where as {
      updatedAt: { lt: Date };
    };
    // Only a connection unchanged since the call began is marked; a reconnect
    // in between updates it, so the stale failure leaves it alone.
    expect(where.updatedAt.lt.getTime()).toBeLessThanOrEqual(
      startedBy.getTime(),
    );
  });
});
