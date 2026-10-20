import {
  ActionType,
  DraftEmailStatus,
  ExecutedRuleStatus,
} from "@/generated/prisma/enums";
import {
  getErrorTypes,
  getWatchStatus,
} from "@/utils/analytics/mailbox-health";
import {
  getGetStartedItems,
  getGetStartedStatus,
} from "@/utils/get-started/checklist";
import { getGetStartedFacts } from "@/utils/get-started/checklist.server";
import prisma from "@/utils/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;
export const SUGGESTION_WINDOW_DAYS = 30;
// Far above the friends beta; most recently active first.
const MAX_USERS = 500;
// Bounds the suggestions read, as the draft funnel does.
const MAX_SUGGESTION_ROWS = 100_000;

/**
 * One row per person: when they were last in the app, their mailboxes'
 * health, their get-started progress and how Cue's suggested replies did.
 * Counts, dates and states only: no mail content, subjects or senders.
 */
export async function getBetaTesters(now = new Date()) {
  const users = await prisma.user.findMany({
    orderBy: [{ lastLogin: { sort: "desc", nulls: "last" } }],
    take: MAX_USERS,
    select: {
      id: true,
      email: true,
      name: true,
      createdAt: true,
      lastLogin: true,
      dismissedHints: true,
      errorMessages: true,
      emailAccounts: {
        select: {
          id: true,
          watchEmailsExpirationDate: true,
          account: { select: { provider: true, disconnectedAt: true } },
        },
      },
    },
  });
  const emailAccountIds = users.flatMap((user) =>
    user.emailAccounts.map((account) => account.id),
  );
  const inAccounts = { emailAccountId: { in: emailAccountIds } };
  const suggestionsSince = new Date(
    now.getTime() - SUGGESTION_WINDOW_DAYS * DAY_MS,
  );

  const [facts, lastProcessed, recentErrors, suggestions] = await Promise.all([
    getGetStartedFacts(emailAccountIds),
    // The last incoming mail Cue processed without failing, as the
    // first-hour health snapshot reads it.
    prisma.executedRule.groupBy({
      by: ["emailAccountId"],
      where: {
        ...inAccounts,
        status: { not: ExecutedRuleStatus.ERROR },
        createdAt: { gte: suggestionsSince },
      },
      _max: { createdAt: true },
    }),
    prisma.executedRule.groupBy({
      by: ["emailAccountId"],
      where: {
        ...inAccounts,
        status: ExecutedRuleStatus.ERROR,
        createdAt: { gte: new Date(now.getTime() - DAY_MS) },
      },
      _count: { _all: true },
    }),
    // The draft funnel's suggestions: waiting in Cue, with a status.
    prisma.executedAction.findMany({
      where: {
        type: ActionType.DRAFT_EMAIL,
        draftId: null,
        draftStatus: { not: null },
        createdAt: { gte: suggestionsSince },
        executedRule: inAccounts,
      },
      select: {
        draftStatus: true,
        replySuggestionShownAt: true,
        executedRule: { select: { emailAccountId: true } },
      },
      orderBy: { createdAt: "desc" },
      take: MAX_SUGGESTION_ROWS,
    }),
  ]);

  const lastProcessedAt = new Map(
    lastProcessed.map((row) => [row.emailAccountId, row._max.createdAt]),
  );
  const errorCount = new Map(
    recentErrors.map((row) => [row.emailAccountId, row._count._all]),
  );
  const suggestionCounts = new Map<string, { shown: number; sent: number }>();
  for (const row of suggestions) {
    const id = row.executedRule.emailAccountId;
    const counts = suggestionCounts.get(id) ?? { shown: 0, sent: 0 };
    if (row.replySuggestionShownAt) counts.shown++;
    if (row.draftStatus === DraftEmailStatus.LIKELY_SENT) counts.sent++;
    suggestionCounts.set(id, counts);
  }

  return {
    truncated: suggestions.length === MAX_SUGGESTION_ROWS,
    testers: users.map((user) => {
      const accountIds = user.emailAccounts.map((account) => account.id);
      const items = getGetStartedItems({
        dismissedHints: user.dismissedHints,
        emailAccountIds: accountIds,
        facts,
      });
      const syncIssues = new Set<string>();
      for (const account of user.emailAccounts) {
        if (account.account.disconnectedAt) syncIssues.add("disconnected");
        const watch = getWatchStatus(account.watchEmailsExpirationDate, now);
        if (watch !== "active") syncIssues.add(`watch ${watch}`);
        for (const type of getErrorTypes(user.errorMessages, account.id))
          syncIssues.add(type);
      }
      return {
        id: user.id,
        email: user.email,
        name: user.name,
        joinedAt: user.createdAt,
        lastActiveAt: user.lastLogin,
        providers: user.emailAccounts.map(
          (account) => account.account.provider,
        ),
        lastProcessedAt: latest(
          accountIds.map((id) => lastProcessedAt.get(id) ?? null),
        ),
        errorsLast24h: sum(accountIds.map((id) => errorCount.get(id) ?? 0)),
        syncIssues: [...syncIssues],
        checklist: {
          done: items.filter((item) => item.done).length,
          total: items.length,
          status: getGetStartedStatus({ user, items, now }),
        },
        suggestions: {
          shown: sum(
            accountIds.map((id) => suggestionCounts.get(id)?.shown ?? 0),
          ),
          sent: sum(
            accountIds.map((id) => suggestionCounts.get(id)?.sent ?? 0),
          ),
        },
      };
    }),
  };
}

function latest(dates: (Date | null)[]) {
  return dates.reduce<Date | null>(
    (max, date) => (date && (!max || date > max) ? date : max),
    null,
  );
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
