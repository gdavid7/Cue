import type { Prisma } from "@/generated/prisma/client";
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import prisma from "@/utils/prisma";

// Apps hosted by an integration provider, which knows the person by the id of
// the mailbox they connected from, so the connection can't change mailbox.
const PROVIDER_HOSTED_APPS = Object.values(MCP_INTEGRATIONS)
  .filter((integration) => integration.provider)
  .map((integration) => integration.name);

/** The mailbox that stays when one is removed: the oldest other one. */
export function remainingEmailAccountQuery({
  userId,
  removedEmailAccountId,
}: {
  userId: string;
  removedEmailAccountId: string;
}) {
  return {
    where: { userId, id: { not: removedEmailAccountId } },
    orderBy: { createdAt: "asc" as const },
  };
}

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
  const stays = await getStayingConnectionFilters(toEmailAccountId);
  const from = { emailAccountId: fromEmailAccountId, emailAccount: { userId } };
  const data = { emailAccountId: toEmailAccountId };

  return [
    prisma.calendarConnection.updateMany({
      where: { ...from, ...(stays.calendar ? { NOT: stays.calendar } : {}) },
      data,
    }),
    prisma.driveConnection.updateMany({
      where: { ...from, ...(stays.drive ? { NOT: stays.drive } : {}) },
      data,
    }),
    // Custom app servers the person registered from this mailbox.
    prisma.mcpIntegration.updateMany({ where: from, data }),
    prisma.mcpConnection.updateMany({
      where: { ...from, NOT: stays.app },
      data,
    }),
  ];
}

/**
 * The connections removing a mailbox deletes rather than moves, named for the
 * person deciding whether to remove it. What stays behind as an exact copy of
 * one the remaining mailbox has (the same calendar account, the same Drive
 * account, the same app) is not lost, so it isn't named.
 */
export async function getConnectionsLostOnRemoval({
  userId,
  fromEmailAccountId,
  toEmailAccountId,
}: {
  userId: string;
  fromEmailAccountId: string;
  toEmailAccountId: string;
}): Promise<string[]> {
  const stays = await getStayingConnectionFilters(toEmailAccountId);
  const from = { emailAccountId: fromEmailAccountId, emailAccount: { userId } };
  const [drives, apps] = await Promise.all([
    stays.drive
      ? prisma.driveConnection.findMany({
          where: { ...from, ...stays.drive },
          select: { provider: true, email: true },
        })
      : [],
    prisma.mcpConnection.findMany({
      where: { ...from, ...stays.app },
      select: { integrationId: true, integration: { select: { name: true } } },
    }),
  ]);

  return [
    ...drives
      .filter(
        (drive) =>
          !stays.remaining.drives.some(
            (kept) =>
              kept.provider === drive.provider && kept.email === drive.email,
          ),
      )
      .map(
        ({ provider, email }) =>
          `${provider === "microsoft" ? "OneDrive" : "Google Drive"} (${email})`,
      ),
    ...new Set(
      apps
        .filter((app) => !stays.remaining.appIds.includes(app.integrationId))
        .map(
          ({ integration }) =>
            MCP_INTEGRATIONS[integration.name]?.displayName ?? integration.name,
        ),
    ),
  ];
}

/**
 * Which of a removed mailbox's connections stay behind with it: what the
 * remaining mailbox has its own copy of, and apps that can't change mailbox.
 * A null filter means none of that kind stays.
 */
async function getStayingConnectionFilters(toEmailAccountId: string) {
  const [calendars, drives, apps] = await Promise.all([
    prisma.calendarConnection.findMany({
      where: { emailAccountId: toEmailAccountId },
      select: { provider: true, email: true },
    }),
    prisma.driveConnection.findMany({
      where: { emailAccountId: toEmailAccountId },
      select: { provider: true, email: true },
    }),
    prisma.mcpConnection.findMany({
      where: { emailAccountId: toEmailAccountId },
      select: { integrationId: true },
    }),
  ]);
  return {
    remaining: {
      drives,
      appIds: apps.map(({ integrationId }) => integrationId),
    },
    calendar: calendars.length
      ? {
          OR: calendars.map(({ provider, email }) => ({ provider, email })),
        }
      : null,
    drive: drives.length
      ? { provider: { in: drives.map(({ provider }) => provider) } }
      : null,
    app: {
      OR: [
        { integration: { name: { in: PROVIDER_HOSTED_APPS } } },
        ...(apps.length
          ? [
              {
                integrationId: {
                  in: apps.map(({ integrationId }) => integrationId),
                },
              },
            ]
          : []),
      ],
    },
  } satisfies {
    remaining: unknown;
    calendar: Prisma.CalendarConnectionWhereInput | null;
    drive: Prisma.DriveConnectionWhereInput | null;
    app: Prisma.McpConnectionWhereInput;
  };
}
