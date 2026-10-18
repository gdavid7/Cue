import type { Prisma } from "@/generated/prisma/client";

/**
 * Matches rows owned by any email account of the person who owns
 * `emailAccountId`, and never another person's. Integrations (connected apps,
 * calendars, drives) belong to the person rather than to one mailbox, so reads
 * widen from the authorised account to its siblings with this filter.
 *
 * `emailAccountId` must already be authorised for the requester, as the
 * `withEmailAccount` middleware and `actionClient` do.
 */
export function ownedBySameUser(emailAccountId: string): {
  emailAccount: Prisma.EmailAccountWhereInput;
} {
  // Prisma drops an undefined filter, so `some: { id: undefined }` would match
  // every person's rows.
  if (!emailAccountId) {
    throw new Error("ownedBySameUser requires an email account id");
  }
  return {
    emailAccount: { user: { emailAccounts: { some: { id: emailAccountId } } } },
  };
}

/**
 * One connection per external account (a calendar or drive login), for when
 * the person connected the same one from two of their mailboxes. A connected
 * row beats a disconnected one; otherwise the choice is stable (lowest id), so
 * every mailbox shows and reads the same row.
 */
export function onePerExternalAccount<
  T extends {
    id: string;
    provider: string;
    email: string;
    isConnected?: boolean;
  },
>(connections: T[]): T[] {
  const kept = new Map<string, T>();
  for (const connection of connections) {
    const key = externalAccountKey(connection);
    const current = kept.get(key);
    if (!current || isPreferred(connection, current)) kept.set(key, connection);
  }
  return connections.filter(
    (connection) => kept.get(externalAccountKey(connection)) === connection,
  );
}

function externalAccountKey(connection: { provider: string; email: string }) {
  return `${connection.provider}:${connection.email.toLowerCase()}`;
}

function isPreferred(
  candidate: { id: string; isConnected?: boolean },
  current: { id: string; isConnected?: boolean },
) {
  const candidateConnected = candidate.isConnected !== false;
  const currentConnected = current.isConnected !== false;
  if (candidateConnected !== currentConnected) return candidateConnected;
  return candidate.id < current.id;
}
