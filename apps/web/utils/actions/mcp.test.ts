import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  connectWithCredentialsAction,
  createCustomMcpServerAction,
  testMcpConnectionAction,
} from "@/utils/actions/mcp";
import { createCustomMcpServerBody } from "@/utils/actions/mcp.validation";
import { ConnectionExpiredError } from "@/utils/mcp/providers/types";

const {
  mockSyncMcpTools,
  mockSafeExternalFetch,
  mockConnectWithCredentials,
  mockCheckConnection,
} = vi.hoisted(() => ({
  mockSyncMcpTools: vi.fn(),
  mockSafeExternalFetch: vi.fn(),
  mockConnectWithCredentials: vi.fn(),
  mockCheckConnection: vi.fn(),
}));

const TOKEN = "test-canvas-token";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "owner@example.com" },
    session: {},
  })),
}));
vi.mock("@/utils/mcp/sync-tools", () => ({
  syncMcpTools: mockSyncMcpTools,
}));
vi.mock("@/utils/mcp/safe-fetch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/mcp/safe-fetch")>()),
  safeExternalFetch: mockSafeExternalFetch,
}));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({
    isConfigured: () => true,
    connectWithCredentials: mockConnectWithCredentials,
    checkConnection: mockCheckConnection,
  }),
}));

describe("createCustomMcpServerBody", () => {
  it("requires an API key when the server uses one", () => {
    const result = createCustomMcpServerBody.safeParse({
      displayName: "Docs",
      serverUrl: "https://mcp.example.com/mcp",
      authType: "api-token",
    });

    expect(result.success).toBe(false);
  });

  it("does not require an API key for OAuth servers", () => {
    const result = createCustomMcpServerBody.safeParse({
      displayName: "Docs",
      serverUrl: "https://mcp.example.com/mcp",
      authType: "oauth",
    });

    expect(result.success).toBe(true);
  });
});

describe("custom MCP server actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "user-1", provider: "google" },
    } as never);
    prisma.user.findUnique.mockResolvedValue({
      premium: {
        tier: "PROFESSIONAL_MONTHLY",
        stripeSubscriptionStatus: "active",
      },
    } as never);
    prisma.mcpIntegration.count.mockResolvedValue(0);
    prisma.mcpIntegration.create.mockResolvedValue({
      id: "integration-1",
    } as never);
  });

  it("rejects a server URL that is not https", async () => {
    const result = await createCustomMcpServerAction("account-1", {
      displayName: "Docs",
      serverUrl: "http://mcp.example.com/mcp",
      authType: "oauth",
    });

    expect(result?.serverError).toBe("The server URL must use https");
    expect(prisma.mcpIntegration.create).not.toHaveBeenCalled();
  });

  it("rejects a server URL that resolves to a private address", async () => {
    const result = await createCustomMcpServerAction("account-1", {
      displayName: "Docs",
      serverUrl: "https://10.0.0.1/mcp",
      authType: "oauth",
    });

    expect(result?.serverError).toBe("That server URL is not a public address");
    expect(prisma.mcpIntegration.create).not.toHaveBeenCalled();
  });

  it("removes the server again when the first tool sync fails", async () => {
    mockSyncMcpTools.mockRejectedValue(new Error("connection refused"));

    const result = await createCustomMcpServerAction("account-1", {
      displayName: "Docs",
      serverUrl: "https://mcp.example.com/mcp",
      authType: "api-token",
      apiKey: "secret",
    });

    expect(result?.serverError).toBe(
      "Could not connect to the server. Check the URL and API key.",
    );
    expect(prisma.mcpIntegration.delete).toHaveBeenCalledWith({
      where: { id: "integration-1" },
    });
  });
});

describe("connectWithCredentialsAction for Canvas", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "user-1", provider: "google" },
    } as never);
    prisma.user.findUnique.mockResolvedValue({
      premium: {
        tier: "PROFESSIONAL_MONTHLY",
        stripeSubscriptionStatus: "active",
      },
    } as never);
    prisma.mcpConnection.findMany.mockResolvedValue([]);
    prisma.mcpIntegration.upsert.mockResolvedValue({
      id: "integration-canvas",
    } as never);
    mockSyncMcpTools.mockResolvedValue(undefined);
    mockConnectWithCredentials.mockResolvedValue(undefined);
  });

  const connect = (address = "https://canvas.eee.uci.edu/courses/12") =>
    connectWithCredentialsAction("account-1", {
      integration: "canvas",
      credentials: { full: address, generic_api_key: TOKEN },
    });

  it("saves the connection with who Canvas says the token belongs to", async () => {
    mockSafeExternalFetch.mockResolvedValue(
      json(200, { id: 42, name: "Ada Lovelace" }),
    );

    const result = await connect();

    expect(result?.serverError).toBeUndefined();
    expect(result?.data).toEqual({ name: "Ada Lovelace" });
    expect(mockSafeExternalFetch).toHaveBeenCalledWith(
      "https://canvas.eee.uci.edu/api/v1/users/self",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: `Bearer ${TOKEN}`,
        }),
      }),
    );
    // The provider gets the address in the form it expects: the origin
    expect(mockConnectWithCredentials).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          full: "https://canvas.eee.uci.edu",
          generic_api_key: TOKEN,
        },
      }),
    );
    const saved = prisma.mcpConnection.upsert.mock.calls[0][0];
    for (const data of [saved.create, saved.update]) {
      expect(data).toMatchObject({
        verifiedAs: "Ada Lovelace",
        verifiedAsId: "42",
        needsReconnectAt: null,
      });
      expect(data.verifiedAt).toBeInstanceOf(Date);
    }
  });

  it.each([
    [
      json(401, { errors: [{ message: "Invalid access token." }] }),
      "Canvas rejected this token. Check it or create a new one.",
    ],
    [
      new Response("<html></html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
      "That address doesn't look like a Canvas site.",
    ],
    [
      json(503, { errors: [{ message: "Down for maintenance" }] }),
      "Couldn't reach Canvas. Try again.",
    ],
  ])("saves nothing when Canvas doesn't confirm the token (%#)", async (response, message) => {
    mockSafeExternalFetch.mockResolvedValue(response);

    const result = await connect();

    expect(result?.serverError).toBe(message);
    expect(mockConnectWithCredentials).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
  });

  it("saves nothing when Canvas can't be reached", async () => {
    mockSafeExternalFetch.mockRejectedValue(new TypeError("fetch failed"));

    const result = await connect();

    expect(result?.serverError).toBe("Couldn't reach Canvas. Try again.");
    expect(mockConnectWithCredentials).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
  });

  it("never calls a private address", async () => {
    const result = await connect("https://169.254.169.254");

    expect(result?.serverError).toBe(
      "That address doesn't look like a Canvas site.",
    );
    expect(mockSafeExternalFetch).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
  });

  it("answers with a plain error, not a crash, when storing the token fails", async () => {
    mockSafeExternalFetch.mockResolvedValue(json(200, { id: 1, name: "Ada" }));
    mockConnectWithCredentials.mockRejectedValue(
      new Error(
        "Composio request failed: POST /connected_accounts returned 500",
      ),
    );

    const result = await connect();

    expect(result?.serverError).toBe("Couldn't reach Canvas. Try again.");
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
  });
});

describe("testMcpConnectionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "owner@example.com",
      account: { userId: "user-1", provider: "google" },
    } as never);
    prisma.mcpConnection.findFirst.mockResolvedValue({
      id: "connection-canvas",
      emailAccountId: "account-1",
      integration: { name: "canvas" },
    } as never);
  });

  it("records who the stored token still belongs to", async () => {
    mockCheckConnection.mockResolvedValue({
      response_data: { id: 42, name: "Ada Lovelace" },
    });

    const result = await testMcpConnectionAction("account-1", {
      connectionId: "connection-canvas",
    });

    expect(result?.data).toEqual({ name: "Ada Lovelace" });
    expect(prisma.mcpConnection.update).toHaveBeenCalledWith({
      where: { id: "connection-canvas" },
      data: expect.objectContaining({
        verifiedAs: "Ada Lovelace",
        verifiedAsId: "42",
        needsReconnectAt: null,
        verifiedAt: expect.any(Date),
      }),
    });
  });

  it("marks the connection for reconnecting when Canvas turns the token away", async () => {
    mockCheckConnection.mockRejectedValue(
      new ConnectionExpiredError("canvas", "Invalid access token."),
    );

    const result = await testMcpConnectionAction("account-1", {
      connectionId: "connection-canvas",
    });

    expect(result?.serverError).toBe(
      "Canvas rejected this token. Check it or create a new one.",
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

  it("leaves the connection alone when Canvas is just unreachable", async () => {
    mockCheckConnection.mockRejectedValue(new Error("internal_server_error"));

    const result = await testMcpConnectionAction("account-1", {
      connectionId: "connection-canvas",
    });

    expect(result?.serverError).toBe("Couldn't reach Canvas. Try again.");
    expect(prisma.mcpConnection.updateMany).not.toHaveBeenCalled();
    expect(prisma.mcpConnection.update).not.toHaveBeenCalled();
  });

  it("only tests the person's own connections", async () => {
    prisma.mcpConnection.findFirst.mockResolvedValue(null);

    const result = await testMcpConnectionAction("account-1", {
      connectionId: "someone-elses",
    });

    expect(result?.serverError).toBe("Connection not found");
    expect(mockCheckConnection).not.toHaveBeenCalled();
  });
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
