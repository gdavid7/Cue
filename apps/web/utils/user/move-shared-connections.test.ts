import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import {
  getConnectionsLostOnRemoval,
  getMoveSharedConnectionsOperations,
} from "./move-shared-connections";

vi.mock("@/utils/prisma");

const providerHostedApps = Object.values(MCP_INTEGRATIONS)
  .filter((integration) => integration.provider)
  .map((integration) => integration.name);

const fromRemoved = {
  emailAccountId: "removed",
  emailAccount: { userId: "user-1" },
};

describe("getMoveSharedConnectionsOperations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.calendarConnection.findMany.mockResolvedValue([]);
    prisma.driveConnection.findMany.mockResolvedValue([]);
    prisma.mcpConnection.findMany.mockResolvedValue([]);
  });

  it("moves the removed mailbox's calendars, Drive and apps to the one that stays", async () => {
    const operations = await getMoveSharedConnectionsOperations({
      userId: "user-1",
      fromEmailAccountId: "removed",
      toEmailAccountId: "remaining",
    });

    expect(operations).toHaveLength(4);
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: fromRemoved,
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.driveConnection.updateMany).toHaveBeenCalledWith({
      where: fromRemoved,
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.mcpIntegration.updateMany).toHaveBeenCalledWith({
      where: fromRemoved,
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
      where: {
        ...fromRemoved,
        // A provider-hosted app knows the person by the removed mailbox's id.
        NOT: { OR: [{ integration: { name: { in: providerHostedApps } } }] },
      },
      data: { emailAccountId: "remaining" },
    });
  });

  it("leaves behind what the remaining mailbox already has its own copy of", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      { provider: "google", email: "cal@example.com" },
    ] as never);
    prisma.driveConnection.findMany.mockResolvedValue([
      { provider: "microsoft" },
    ] as never);
    prisma.mcpConnection.findMany.mockResolvedValue([
      { integrationId: "notion-id" },
    ] as never);

    await getMoveSharedConnectionsOperations({
      userId: "user-1",
      fromEmailAccountId: "removed",
      toEmailAccountId: "remaining",
    });

    expect(prisma.calendarConnection.findMany).toHaveBeenCalledWith({
      where: { emailAccountId: "remaining" },
      select: { provider: true, email: true },
    });
    expect(prisma.calendarConnection.updateMany).toHaveBeenCalledWith({
      where: {
        ...fromRemoved,
        NOT: { OR: [{ provider: "google", email: "cal@example.com" }] },
      },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.driveConnection.updateMany).toHaveBeenCalledWith({
      where: { ...fromRemoved, NOT: { provider: { in: ["microsoft"] } } },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
      where: {
        ...fromRemoved,
        NOT: {
          OR: [
            { integration: { name: { in: providerHostedApps } } },
            { integrationId: { in: ["notion-id"] } },
          ],
        },
      },
      data: { emailAccountId: "remaining" },
    });
  });
});

describe("getConnectionsLostOnRemoval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("names the connections that stay behind with the removed mailbox", async () => {
    // The remaining mailbox's own connections, then the removed one's left behind.
    prisma.calendarConnection.findMany
      .mockResolvedValueOnce([
        { provider: "google", email: "cal@example.com" },
      ] as never)
      .mockResolvedValueOnce([
        { provider: "google", email: "cal@example.com" },
      ] as never);
    prisma.driveConnection.findMany.mockResolvedValueOnce([] as never);
    prisma.mcpConnection.findMany
      .mockResolvedValueOnce([] as never)
      .mockResolvedValueOnce([
        { integration: { name: "hubspot" } },
        { integration: { name: "hubspot" } },
      ] as never);

    const lost = await getConnectionsLostOnRemoval({
      userId: "user-1",
      fromEmailAccountId: "removed",
      toEmailAccountId: "remaining",
    });

    expect(lost).toEqual(["Google Calendar (cal@example.com)", "HubSpot"]);
    expect(prisma.calendarConnection.findMany).toHaveBeenLastCalledWith({
      where: {
        ...fromRemoved,
        OR: [{ provider: "google", email: "cal@example.com" }],
      },
      select: { provider: true, email: true },
    });
    // No Drive of the remaining mailbox's, so every Drive moves.
    expect(prisma.driveConnection.findMany).toHaveBeenCalledOnce();
  });
});
