import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";

// Connected apps belong to the person, not to one mailbox: an app connected
// from any of their email accounts serves all of them. Each connection stays on
// the account it was made from, because that account is the identity its
// provider (Composio's user_id) and stored credentials know, so anything that
// acts on a connection uses its own emailAccountId.

/**
 * Matches rows (connections or custom servers) owned by any email account of
 * the person who owns `emailAccountId`, and never another person's.
 */
export function ownedBySameUser(emailAccountId: string): {
  emailAccount: Prisma.EmailAccountWhereInput;
} {
  return {
    emailAccount: { user: { emailAccounts: { some: { id: emailAccountId } } } },
  };
}

/**
 * One connection per app. Should a person have connected the same app from
 * two accounts, the account being viewed keeps its own.
 */
export function onePerIntegration<
  T extends { emailAccountId: string | null; integration: { name: string } },
>(connections: T[], emailAccountId: string): T[] {
  const byName = new Map<string, T>();
  for (const connection of connections) {
    const kept = byName.get(connection.integration.name);
    if (
      !kept ||
      (kept.emailAccountId !== emailAccountId &&
        connection.emailAccountId === emailAccountId)
    ) {
      byName.set(connection.integration.name, connection);
    }
  }
  return [...byName.values()];
}

/**
 * The account holding the person's connection to an app, or null when none of
 * their accounts has connected it.
 */
export async function findConnectionAccountId({
  integration,
  emailAccountId,
  activeOnly = false,
}: {
  integration: string;
  emailAccountId: string;
  activeOnly?: boolean;
}): Promise<string | null> {
  const connections = await prisma.mcpConnection.findMany({
    where: {
      integration: { name: integration },
      ...(activeOnly ? { isActive: true } : {}),
      ...ownedBySameUser(emailAccountId),
    },
    select: { emailAccountId: true, integration: { select: { name: true } } },
    orderBy: { createdAt: "asc" },
  });
  return (
    onePerIntegration(connections, emailAccountId)[0]?.emailAccountId ?? null
  );
}
