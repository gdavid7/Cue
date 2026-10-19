import type { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import {
  onePerExternalAccount,
  ownedBySameUser,
} from "@/utils/user/owned-by-same-user";

// Calendars belong to the person, not to one mailbox: a calendar connected
// from any of their email accounts serves all of them. Each connection stays on
// the account it was made from, and anything that refreshes or saves its
// tokens uses that connection's own emailAccountId.

/**
 * The calendar connections an account can use: every connection of the person
 * who owns `emailAccountId`. `ownConnectionsOnly` keeps it to the account's own
 * connections, for automations that must act once per calendar (meeting briefs,
 * the meeting recorder) rather than once per mailbox.
 */
export function calendarConnectionsWhere(
  emailAccountId: string,
  { ownConnectionsOnly = false }: { ownConnectionsOnly?: boolean } = {},
): Prisma.CalendarConnectionWhereInput {
  return ownConnectionsOnly
    ? { emailAccountId }
    : ownedBySameUser(emailAccountId);
}

/** How many distinct connected calendar accounts the account can read. */
export async function countConnectedCalendars(
  emailAccountId: string,
  options?: { ownConnectionsOnly?: boolean },
) {
  const connections = await prisma.calendarConnection.findMany({
    where: {
      ...calendarConnectionsWhere(emailAccountId, options),
      isConnected: true,
    },
    select: { id: true, provider: true, email: true },
  });
  return onePerExternalAccount(connections).length;
}
