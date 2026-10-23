import { Prisma } from "@/generated/prisma/client";
import { ExecutedRuleStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import {
  HISTORY_ACTION_NAMES,
  HISTORY_ACTIONS,
  type HistoryAction,
} from "@/utils/rule/history-actions";

// Past a week "since you were last here" is too long ago to read as news.
export const AWAY_WINDOW_DAYS = 7;

type AwayCounts = Record<HistoryAction, number>;

/**
 * What Cue did in each account since the user's last visit: how many emails
 * it sorted, archived and drafted replies to. Counts only, from Cue's own
 * records; nothing about the mail itself.
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
}) {
  const [user, accounts] = await Promise.all([
    prisma.user.findUnique({
      where: { id: userId },
      select: { previousVisitAt: true },
    }),
    prisma.emailAccount.findMany({
      where: { id: { in: emailAccountIds }, userId },
      select: { id: true },
    }),
  ]);
  const previousVisitAt = user?.previousVisitAt;
  if (!previousVisitAt || !accounts.length)
    return { since: null, capped: false, accounts: [] };

  const windowStart = new Date(now.getTime() - AWAY_WINDOW_DAYS * 86_400_000);
  const capped = previousVisitAt < windowStart;
  const since = capped ? windowStart : previousVisitAt;
  const ids = accounts.map((account) => account.id);

  // One pass over the window's applied rules, through the
  // [emailAccountId, status, createdAt] index, and each rule's actions
  // through [executedRuleId]. Emails, not actions: two labels on one email
  // sorted one email.
  const kind = Prisma.sql`CASE ${Prisma.join(
    HISTORY_ACTION_NAMES.map(
      (name) =>
        Prisma.sql`WHEN ea.type IN (${Prisma.join(
          HISTORY_ACTIONS[name].map(
            (type) => Prisma.sql`${type}::"ActionType"`,
          ),
        )}) THEN ${name}`,
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
      -- What the user did through Cue isn't Cue's work.
      AND er.automated = true
      AND ea.type IN (${Prisma.join(
        Object.values(HISTORY_ACTIONS)
          .flat()
          .map((type) => Prisma.sql`${type}::"ActionType"`),
      )})
      AND (ea."executionStatus" IS NULL OR ea."executionStatus" = 'SUCCEEDED')
    GROUP BY 1, 2
  `);

  return {
    since: since.toISOString(),
    /** The last visit was before the window, which then starts a week ago. */
    capped,
    accounts: ids.map((emailAccountId) => ({
      emailAccountId,
      ...Object.fromEntries(
        HISTORY_ACTION_NAMES.map((name) => [
          name,
          rows.find(
            (row) => row.emailAccountId === emailAccountId && row.kind === name,
          )?.count ?? 0,
        ]),
      ),
    })) as ({ emailAccountId: string } & AwayCounts)[],
  };
}
