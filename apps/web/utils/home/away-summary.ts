import { Prisma } from "@/generated/prisma/client";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import {
  HISTORY_ACTION_NAMES,
  type HistoryAction,
} from "@/utils/rule/history-action-kinds";
import { historyActionCondition } from "@/utils/rule/history-actions";

// Past a week "since you were last here" is too long ago to read as news.
export const AWAY_WINDOW_DAYS = 7;
// The card is about coming back; by evening it's no longer news.
export const AWAY_SHOWN_FOR_MS = 12 * 60 * 60_000;

type AwayCounts = Record<HistoryAction, number>;

const NOTHING_TO_SHOW = {
  since: null,
  until: null,
  capped: false,
  lastVisitAt: null,
  accounts: [],
};

/**
 * What Cue did in each account while the user was away: between their last
 * visit and their return, how many emails it sorted, archived and drafted
 * replies to. Counts only, from Cue's own records; nothing about the mail.
 * Shown for 12 hours after the return, until dismissed.
 */
export async function getAwaySummary({
  userId,
  emailAccountIds,
  now = new Date(),
}: {
  userId: string;
  /** The accounts Today shows; any that aren't the user's are left out. */
  emailAccountIds: string[];
  now?: Date;
}): Promise<{
  /** Where the counts start: the last visit, or a week before the return. */
  since: string | null;
  /** Where they end: the return. */
  until: string | null;
  /** The last visit was more than a week before the return. */
  capped: boolean;
  /** The last visit as stored, which a dismiss sends back. */
  lastVisitAt: string | null;
  accounts: ({ emailAccountId: string } & AwayCounts)[];
}> {
  const [user, accounts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { previousVisitAt: true, visitReturnedAt: true },
    }),
    prisma.emailAccount.findMany({
      where: { id: { in: emailAccountIds }, userId },
      select: { id: true },
    }),
  ]);
  const previousVisitAt = user?.previousVisitAt;
  const returnedAt = user?.visitReturnedAt;
  if (!previousVisitAt || !returnedAt || !accounts.length)
    return NOTHING_TO_SHOW;
  if (now.getTime() - returnedAt.getTime() > AWAY_SHOWN_FOR_MS)
    return NOTHING_TO_SHOW;

  const windowStart = new Date(
    returnedAt.getTime() - AWAY_WINDOW_DAYS * 86_400_000,
  );
  const capped = previousVisitAt < windowStart;
  const since = capped ? windowStart : previousVisitAt;
  const ids = accounts.map((account) => account.id);

  // One pass over the window's applied rules, through the
  // [emailAccountId, status, createdAt] index, and each rule's actions
  // through [executedRuleId]. Emails, not actions: two labels on one email
  // sorted one email. History lists conversations, one row per thread, so a
  // count can be higher than the rows its link shows when several of the
  // emails share a thread (FT-17f).
  const kind = Prisma.sql`CASE ${Prisma.join(
    HISTORY_ACTION_NAMES.map(
      (name) =>
        Prisma.sql`WHEN ${historyActionCondition("ea", [name])} THEN ${name}`,
    ),
    " ",
  )} END`;
  const rows = await prisma.$queryRaw<
    { emailAccountId: string; kind: HistoryAction; count: number }[]
  >(Prisma.sql`
    SELECT er."emailAccountId", ${kind} AS kind,
      COUNT(DISTINCT er."messageId")::int AS count
    FROM "ExecutedRule" er
    JOIN "ExecutedAction" ea ON ea."executedRuleId" = er.id
    WHERE er."emailAccountId" IN (${Prisma.join(ids)})
      AND er.status = ${ExecutedRuleStatus.APPLIED}::"ExecutedRuleStatus"
      AND er."createdAt" >= ${since}
      AND er."createdAt" < ${returnedAt}
      -- What the user did through Cue isn't Cue's work, and History lists
      -- only runs whose rule still exists.
      AND er.automated = true
      AND er."ruleId" IS NOT NULL
      AND ${historyActionCondition("ea", HISTORY_ACTION_NAMES)}
    GROUP BY 1, 2
  `);

  return {
    since: since.toISOString(),
    until: returnedAt.toISOString(),
    capped,
    lastVisitAt: previousVisitAt.toISOString(),
    accounts: ids.map((emailAccountId) => ({
      emailAccountId,
      ...(Object.fromEntries(
        HISTORY_ACTION_NAMES.map((name) => [
          name,
          rows.find(
            (row) => row.emailAccountId === emailAccountId && row.kind === name,
          )?.count ?? 0,
        ]),
      ) as AwayCounts),
    })),
  };
}

/**
 * Hides "While you were away" for the person, on every device, until their
 * next return after a break. Compare-and-clear: it clears only the visit the
 * card showed (`lastVisitAt`), so a tab still showing an earlier card can't
 * wipe a newer return's. Returns whether it cleared anything.
 */
export async function dismissAwaySummary({
  userId,
  lastVisitAt,
}: {
  userId: string;
  lastVisitAt: Date;
}) {
  const { count } = await prisma.user.updateMany({
    where: { id: userId, previousVisitAt: lastVisitAt },
    data: { previousVisitAt: null, visitReturnedAt: null },
  });
  return count > 0;
}
