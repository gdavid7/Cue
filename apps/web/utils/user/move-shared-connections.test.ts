import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import { getMoveSharedConnectionsOperations } from "./move-shared-connections";

vi.mock("@/utils/prisma");

const providerHostedApps = Object.values(MCP_INTEGRATIONS)
  .filter((integration) => integration.provider)
  .map((integration) => integration.name);

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
      where: { emailAccountId: "removed", emailAccount: { userId: "user-1" } },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.driveConnection.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "removed", emailAccount: { userId: "user-1" } },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.mcpIntegration.updateMany).toHaveBeenCalledWith({
      where: { emailAccountId: "removed", emailAccount: { userId: "user-1" } },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "removed",
        emailAccount: { userId: "user-1" },
        // A provider-hosted app knows the person by the removed mailbox's id.
        integration: { name: { notIn: providerHostedApps } },
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
        emailAccountId: "removed",
        emailAccount: { userId: "user-1" },
        NOT: [{ provider: "google", email: "cal@example.com" }],
      },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.driveConnection.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "removed",
        emailAccount: { userId: "user-1" },
        provider: { notIn: ["microsoft"] },
      },
      data: { emailAccountId: "remaining" },
    });
    expect(prisma.mcpConnection.updateMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "removed",
        emailAccount: { userId: "user-1" },
        integration: { name: { notIn: providerHostedApps } },
        integrationId: { notIn: ["notion-id"] },
      },
      data: { emailAccountId: "remaining" },
    });
  });
});
