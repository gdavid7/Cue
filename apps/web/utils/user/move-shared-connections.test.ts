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

  it("names what stays behind, but not exact copies the remaining mailbox has", async () => {
    // The remaining mailbox's own connections.
    prisma.calendarConnection.findMany.mockResolvedValueOnce([
      { provider: "google", email: "cal@example.com" },
    ] as never);
    prisma.driveConnection.findMany
      .mockResolvedValueOnce([
        { provider: "google", email: "same@example.com" },
      ] as never)
      // The removed mailbox's Drives that stay behind.
      .mockResolvedValueOnce([
        { provider: "google", email: "same@example.com" },
        { provider: "google", email: "other@example.com" },
      ] as never);
    prisma.mcpConnection.findMany
      .mockResolvedValueOnce([{ integrationId: "notion-id" }] as never)
      .mockResolvedValueOnce([
        { integrationId: "notion-id", integration: { name: "notion" } },
        { integrationId: "hubspot-id", integration: { name: "hubspot" } },
        { integrationId: "hubspot-id", integration: { name: "hubspot" } },
      ] as never);

    const lost = await getConnectionsLostOnRemoval({
      userId: "user-1",
      fromEmailAccountId: "removed",
      toEmailAccountId: "remaining",
    });

    // The same calendar account, Drive account and app are kept by the
    // remaining mailbox, so only real losses are named.
    expect(lost).toEqual(["Google Drive (other@example.com)", "HubSpot"]);
    expect(prisma.driveConnection.findMany).toHaveBeenLastCalledWith({
      where: { ...fromRemoved, provider: { in: ["google"] } },
      select: { provider: true, email: true },
    });
  });

  it("names nothing when every connection can move", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([] as never);
    prisma.driveConnection.findMany.mockResolvedValue([] as never);
    prisma.mcpConnection.findMany.mockResolvedValue([] as never);

    await expect(
      getConnectionsLostOnRemoval({
        userId: "user-1",
        fromEmailAccountId: "removed",
        toEmailAccountId: "remaining",
      }),
    ).resolves.toEqual([]);
  });
});
