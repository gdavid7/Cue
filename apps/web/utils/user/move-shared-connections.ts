import type { Prisma } from "@/generated/prisma/client";
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import prisma from "@/utils/prisma";

// Apps hosted by an integration provider, which knows the person by the id of
// the mailbox they connected from, so the connection can't change mailbox.
const PROVIDER_HOSTED_APPS = Object.values(MCP_INTEGRATIONS)
  .filter((integration) => integration.provider)
  .map((integration) => integration.name);

/**
 * Calendars, Drive and connected apps serve every mailbox of the person, but
 * each connection row belongs to the mailbox it was made from and is deleted
 * with it. Removing a mailbox moves its connections to one that stays, so the
 * others keep them. What the remaining mailbox already has its own copy of (the
 * same calendar account, a Drive from the same provider, the same app) stays
 * behind and is removed as before.
 *
 * Returns the writes for the removal's transaction, so the connections move
 * only if the mailbox is actually deleted.
 */
export async function getMoveSharedConnectionsOperations({
  userId,
  fromEmailAccountId,
  toEmailAccountId,
}: {
  userId: string;
  fromEmailAccountId: string;
  toEmailAccountId: string;
}): Promise<Prisma.PrismaPromise<unknown>[]> {
  const [calendars, drives, apps] = await Promise.all([
    prisma.calendarConnection.findMany({
      where: { emailAccountId: toEmailAccountId },
      select: { provider: true, email: true },
    }),
    prisma.driveConnection.findMany({
      where: { emailAccountId: toEmailAccountId },
      select: { provider: true },
    }),
    prisma.mcpConnection.findMany({
      where: { emailAccountId: toEmailAccountId },
      select: { integrationId: true },
    }),
  ]);
  const data = { emailAccountId: toEmailAccountId };

  return [
    prisma.calendarConnection.updateMany({
      where: {
        emailAccountId: fromEmailAccountId,
        emailAccount: { userId },
        ...(calendars.length > 0
          ? {
              NOT: calendars.map(({ provider, email }) => ({
                provider,
                email,
              })),
            }
          : {}),
      },
      data,
    }),
    prisma.driveConnection.updateMany({
      where: {
        emailAccountId: fromEmailAccountId,
        emailAccount: { userId },
        ...(drives.length > 0
          ? { provider: { notIn: drives.map(({ provider }) => provider) } }
          : {}),
      },
      data,
    }),
    // Custom app servers the person registered from this mailbox.
    prisma.mcpIntegration.updateMany({
      where: { emailAccountId: fromEmailAccountId, emailAccount: { userId } },
      data,
    }),
    prisma.mcpConnection.updateMany({
      where: {
        emailAccountId: fromEmailAccountId,
        emailAccount: { userId },
        integration: { name: { notIn: PROVIDER_HOSTED_APPS } },
        ...(apps.length > 0
          ? {
              integrationId: {
                notIn: apps.map(({ integrationId }) => integrationId),
              },
            }
          : {}),
      },
      data,
    }),
  ];
}
