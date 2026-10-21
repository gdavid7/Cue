import { TZDate } from "@date-fns/tz";
import { DRAFT_WINDOW_DAYS } from "@/utils/reply-tracker/suggestion-window";
import { startOfDay } from "date-fns";
import {
  ActionType,
  DraftEmailStatus,
  ExecutedRuleStatus,
  ScheduledActionStatus,
  SystemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import {
  extractEmailAddress,
  extractNameFromEmail,
  splitRecipientList,
} from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import type {
  EmailLabel,
  EmailProvider,
  EmailThread,
} from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  holdGmailInteractiveDemand,
  isGmailCallDeferredError,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { getTrackedThreads } from "@/utils/reply-tracker/tracked-threads";
import { getReadySuggestionMessageIds } from "@/utils/reply-tracker/ready-suggestions";
import { getSuggestedReplySettings } from "@/utils/thread-context/suggest-reply";
import { getNextUp } from "@/utils/home/next-up";
import {
  HANDLED_WINDOW_DAYS,
  HOME_LANE_LIMIT,
  MINUTES_PER_REPLY,
  PRIORITY_ORDER,
} from "@/utils/home/today-constants";
import { getRuleLabel } from "@/utils/rule/consts";
import {
  getUserTier,
  hasAiAccess,
  isPremiumRecord,
  premiumEntitlementSelect,
} from "@/utils/premium";
import {
  isReplyTrackingOn,
  REPLY_TRACKING_RULES,
} from "@/utils/reply-tracker/reply-tracking-status";

const LIST_LIMIT = HOME_LANE_LIMIT;
// Well inside the route's 30 seconds, and about as long as a person watches a
// loading page before giving up on it.
const HOME_BUDGET_MS = 10_000;
// Older pending drafts were most likely deleted in the mail app, and a rule
// still "applying" after this long has crashed; neither is work in progress.
const RUNNING_WINDOW_MINUTES = 30;
// A day's filing actions; far more than one inbox gets in a day.
const FILED_ACTIONS_LIMIT = 2000;
/** Labels Inbox Zero's rules file mail under without asking the user. */
export const HANDLED_LABELS = [
  "Newsletter",
  "Marketing",
  "Receipt",
  "Notification",
];
const HIDDEN_TAGS = new Set([
  "inbox",
  "unread",
  "sent",
  "important",
  "starred",
]);
const URGENT =
  /\b(today|tonight|tomorrow|asap|urgent|deadline|due|before (mon|tues|wednes|thurs|fri|satur|sun)day|by (mon|tues|wednes|thurs|fri|satur|sun)day)\b/i;

export type Priority = "high" | "medium" | "low";

export type HomeThread = {
  threadId: string;
  fromName: string;
  fromEmail: string;
  subject: string;
  preview: string;
  at: string;
  tag?: string;
  priority: Priority;
  unread: boolean;
  /** The newest message that isn't a draft. */
  messageId: string;
  /**
   * That message's Message-ID header, the same in every mailbox it is in, so
   * Today across accounts can show a conversation once.
   */
  rfcMessageId?: string;
  starred: boolean;
  /** Waiting-on conversations can be archived; the other lanes are inbox mail. */
  inInbox: boolean;
  /** A reply Cue wrote to the newest message is waiting in Cue. */
  cueDrafted?: boolean;
};

export type AgentTask = {
  id: string;
  kind: "draft" | "scheduled" | "processing";
  threadId: string;
  title: string;
  detail: string;
  at: string;
};

/**
 * Everything the home screen shows, in one request: what needs the user, what
 * the assistant is doing, who owes them a reply, and what was filed for them.
 */
export async function getHomeData({
  emailAccountId,
  userEmail,
  ownAddresses = [userEmail],
  emailProvider,
  logger,
  timeZone = "UTC",
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  /** Every address the user has connected; a meeting any of them declined is off. */
  ownAddresses?: string[] | Promise<string[]>;
  emailProvider: EmailProvider;
  logger: Logger;
  /** The user's IANA time zone, which decides where "today" starts. */
  timeZone?: string;
  now?: Date;
}) {
  // Today waits on Gmail for the rows it shows, behind whatever else the
  // account is doing. A lane that can't be served in time comes back pending,
  // for the client to fetch again, rather than holding up or failing the rest.
  const deadline = Date.now() + HOME_BUDGET_MS;
  // Someone is looking at the page: its reads go ahead of sync and background
  // work, which also hold back while it loads, as they do for an assistant
  // turn. Its many small reads would otherwise get only what sync leaves.
  const releaseDemand = holdGmailInteractiveDemand(
    emailAccountId,
    HOME_BUDGET_MS,
  );
  const gmail = <T>(lane: HomeLane | "labels", work: () => Promise<T>) =>
    withinBudget(
      runWithGmailQuota(
        { priority: "interactive", maxTotalWaitMs: HOME_BUDGET_MS },
        work,
      ),
      deadline,
    ).catch((error): Pending => {
      if (isGmailCallDeferredError(error)) return PENDING;
      logger.warn("Failed to load home lane", { lane, error });
      return FAILED;
    });

  const [
    labelsResult,
    needsYouResult,
    waitingResult,
    inboxResult,
    agentTasks,
    cue,
    today,
    nextUp,
    replySettings,
  ] = await Promise.all([
    gmail("labels", () => emailProvider.getLabels()),
    // Reply tracking lives in Cue's database, so these lanes don't depend
    // on Cue labelling anything in the mailbox. An archived conversation is
    // off the user's plate even before they reply.
    gmail("needsYou", () =>
      getTrackedThreads({
        emailAccountId,
        emailProvider,
        type: ThreadTrackerType.NEEDS_REPLY,
        limit: LIST_LIMIT,
        inboxOnly: true,
      }),
    ),
    gmail("waiting", () =>
      getTrackedThreads({
        emailAccountId,
        emailProvider,
        type: ThreadTrackerType.AWAITING,
        limit: LIST_LIMIT,
      }),
    ),
    // Everything still in the inbox, so nothing is only reachable through AI triage.
    gmail("alsoInInbox", () =>
      emailProvider
        .getThreadsWithQuery({
          query: { labelIds: ["INBOX"] },
          maxResults: LIST_LIMIT,
          messageFormat: "metadata",
        })
        .then((r) => r.threads),
    ),
    getAgentTasks({ emailAccountId, now }),
    getCueStatus(emailAccountId),
    getTodayActivity({
      emailAccountId,
      since: startOfDay(new TZDate(now, timeZone)),
    }),
    getNextUp({ emailAccountId, ownAddresses, timeZone, logger, now }),
    // Only for marking rows with a reply Cue wrote; Today loads without it.
    getSuggestedReplySettings(emailAccountId).catch(() => null),
  ]).finally(() => releaseDemand.then((release) => release()));

  const labels = labelsResult.ok ? labelsResult.value : [];
  const lane = (result: LaneResult<EmailThread[]>) =>
    result.ok ? result.value : [];
  const needsYou = lane(needsYouResult);
  const waiting = lane(waitingResult);
  // Without the labels, filed mail can't be told apart from the rest of the
  // inbox, so that lane waits for a load that has them.
  const inbox = labelsResult.ok ? inboxResult : PENDING;
  const laneResults = [
    ["needsYou", needsYouResult],
    ["waiting", waitingResult],
    ["alsoInInbox", inbox],
  ] as const;
  const pending = laneResults
    .filter(([, result]) => !result.ok && result.pending)
    .map(([name]) => name);
  const failed = laneResults
    .filter(([, result]) => !result.ok && !result.pending)
    .map(([name]) => name);
  if (pending.length) logger.info("Home lanes pending", { pending });

  const labelId = (name: string) => findLabel(labels, name)?.id;
  const labelNames = new Map(labels.map((l) => [l.id, l.name]));
  const toReplyId = labelId(getRuleLabel(SystemType.TO_REPLY));
  const awaitingId = labelId(getRuleLabel(SystemType.AWAITING_REPLY));
  const handledLabelIds = HANDLED_LABELS.map(labelId).filter(isString);
  const handledIds = new Set(handledLabelIds);
  const since = now.getTime() - HANDLED_WINDOW_DAYS * 86_400_000;
  // Each thread shows once on Today. Recently filed mail is Cue's to handle,
  // so it isn't repeated under the rest of the inbox either.
  const shownIds = new Set(needsYou.map((t) => t.id));
  const isRecentlyFiled = (thread: EmailThread) =>
    thread.messages.some(
      (m) =>
        getMessageTimestamp(m) >= since &&
        m.labelIds?.some((id) => handledIds.has(id)),
    );

  const toRow = (thread: EmailThread) =>
    toHomeThread(thread, {
      userEmail,
      labelNames,
      skip: [toReplyId, awaitingId],
    });

  const needsYouRows = needsYou
    .map(toRow)
    .filter(isDefined)
    .sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        b.at.localeCompare(a.at),
    );
  const inboxRows = lane(inbox)
    .filter((t) => !shownIds.has(t.id) && !isRecentlyFiled(t))
    .map(toRow)
    .filter(isDefined);
  // Only mail someone else sent can have a reply waiting; waiting-on
  // conversations are the user's own move.
  const drafted = await getReadySuggestionMessageIds({
    emailAccountId,
    messageIds: [...needsYouRows, ...inboxRows].map((row) => row.messageId),
    draftReplies: replySettings?.draftReplies ?? "off",
    now,
  }).catch((error) => {
    logger.warn("Failed to load drafted replies for home", { error });
    return new Set<string>();
  });
  const withDrafted = (row: HomeThread): HomeThread =>
    drafted.has(row.messageId) ? { ...row, cueDrafted: true } : row;

  return {
    needsYou: needsYouRows.map(withDrafted),
    waiting: waiting.map(toRow).filter(isDefined),
    alsoInInbox: inboxRows.map(withDrafted),
    /**
     * The account's labels for mail Cue files without asking, so the
     * browser's own inbox can leave recently filed mail out as this does.
     */
    handledLabelIds,
    /** Lanes Gmail couldn't serve in time; empty here means "not loaded yet". */
    pending,
    /** Lanes that failed to load; empty here means "unknown", not "nothing". */
    failed,
    agentTasks,
    // Whether an empty lane means "nothing there" or "nobody has looked".
    cue,
    today,
    ...nextUp,
    stats: {
      needsYou: needsYouRows.length,
      estimatedMinutes: needsYouRows.length * MINUTES_PER_REPLY,
      agentWorking: agentTasks.length,
      waiting: waiting.length,
      // Lists are capped, so a full one means "at least this many".
      needsYouCapped: needsYou.length >= LIST_LIMIT,
      waitingCapped: waiting.length >= LIST_LIMIT,
    },
  };
}

/**
 * What Cue did with today's mail, from its own records rather than the
 * mailbox: how many emails it checked, and how many it filed out of the
 * inbox. Where they went, when that's a single label, so it can be checked.
 */
async function getTodayActivity({
  emailAccountId,
  since,
}: {
  emailAccountId: string;
  since: Date;
}) {
  const [checked, actions] = await Promise.all([
    prisma.executedRule.groupBy({
      by: ["messageId"],
      // A message Cue failed to process wasn't checked.
      where: {
        emailAccountId,
        createdAt: { gte: since },
        status: { not: ExecutedRuleStatus.ERROR },
      },
    }),
    prisma.executedAction.findMany({
      where: {
        type: {
          in: [ActionType.ARCHIVE, ActionType.MOVE_FOLDER, ActionType.LABEL],
        },
        // Scoped through the rule, whose [emailAccountId, createdAt] index this uses.
        executedRule: {
          emailAccountId,
          status: ExecutedRuleStatus.APPLIED,
          createdAt: { gte: since },
        },
      },
      select: {
        type: true,
        labelId: true,
        label: true,
        executedRule: { select: { messageId: true } },
      },
      take: FILED_ACTIONS_LIMIT,
    }),
  ]);

  const filed = new Set(
    actions
      .filter((a) => a.type !== ActionType.LABEL)
      .map((a) => a.executedRule.messageId),
  );
  const labels = new Map<string, string>();
  for (const action of actions) {
    if (
      action.type === ActionType.LABEL &&
      action.labelId &&
      filed.has(action.executedRule.messageId)
    ) {
      labels.set(action.labelId, action.label || "");
    }
  }
  const [onlyLabel] = labels.size === 1 ? [...labels] : [];

  return {
    checked: checked.length,
    filed: filed.size,
    filedLabel: onlyLabel
      ? { labelId: onlyLabel[0], name: onlyLabel[1] }
      : null,
  };
}

/**
 * Whether Cue is in a position to say what needs a reply: it has AI access,
 * the To Reply rule is on, and it has read at least some of this mailbox.
 */
async function getCueStatus(emailAccountId: string) {
  const [account, firstRun, firstTracker] = await Promise.all([
    prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: {
        user: {
          select: {
            aiApiKey: true,
            premium: { select: premiumEntitlementSelect },
          },
        },
        rules: REPLY_TRACKING_RULES,
      },
    }),
    prisma.executedRule.findFirst({
      where: { emailAccountId },
      select: { id: true },
    }),
    prisma.threadTracker.findFirst({
      where: { emailAccountId },
      select: { id: true },
    }),
  ]);
  const premium = account?.user.premium;

  return {
    aiAccess:
      isPremiumRecord(premium) &&
      hasAiAccess(getUserTier(premium), !!account?.user.aiApiKey),
    replyTracking: isReplyTrackingOn(account?.rules),
    hasReadMail: Boolean(firstRun || firstTracker),
  };
}

/**
 * What the assistant is doing right now: AI reply drafts waiting for review,
 * actions it has scheduled, and rules still running.
 */
async function getAgentTasks({
  emailAccountId,
  now,
}: {
  emailAccountId: string;
  now: Date;
}): Promise<AgentTask[]> {
  const [drafts, scheduled, running] = await Promise.all([
    prisma.executedAction.findMany({
      where: {
        type: ActionType.DRAFT_EMAIL,
        // A mailbox draft from before, or a suggestion waiting in Cue.
        draftStatus: DraftEmailStatus.PENDING,
        // Scoped through the rule, whose [emailAccountId, createdAt] index this uses.
        executedRule: {
          emailAccountId,
          createdAt: {
            gte: new Date(now.getTime() - DRAFT_WINDOW_DAYS * 86_400_000),
          },
        },
      },
      select: {
        id: true,
        subject: true,
        createdAt: true,
        executedRule: { select: { threadId: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
    prisma.scheduledAction.findMany({
      where: { emailAccountId, status: ScheduledActionStatus.PENDING },
      select: {
        id: true,
        actionType: true,
        threadId: true,
        scheduledFor: true,
      },
      orderBy: { scheduledFor: "asc" },
      take: 5,
    }),
    prisma.executedRule.findMany({
      where: {
        emailAccountId,
        status: ExecutedRuleStatus.APPLYING,
        createdAt: {
          gte: new Date(now.getTime() - RUNNING_WINDOW_MINUTES * 60_000),
        },
      },
      select: {
        id: true,
        threadId: true,
        createdAt: true,
        rule: { select: { name: true } },
      },
      orderBy: { createdAt: "desc" },
      take: 5,
    }),
  ]);

  const tasks: AgentTask[] = [
    ...running.map((r) => ({
      id: r.id,
      kind: "processing" as const,
      threadId: r.threadId,
      title: r.rule?.name ? `Running "${r.rule.name}"` : "Processing an email",
      detail: "Working on it",
      at: r.createdAt.toISOString(),
    })),
    ...drafts.map((d) => ({
      id: d.id,
      kind: "draft" as const,
      threadId: d.executedRule.threadId,
      title: d.subject ? `Suggested reply: ${d.subject}` : "Suggested reply",
      detail: "Ready for your review",
      at: d.createdAt.toISOString(),
    })),
    ...scheduled.map((s) => ({
      id: s.id,
      kind: "scheduled" as const,
      threadId: s.threadId,
      title: `${humanize(s.actionType)} scheduled`,
      detail: "Will run automatically",
      at: s.scheduledFor.toISOString(),
    })),
  ];
  // One task per thread: a running rule that also drafted shows as running.
  return [
    ...new Map(tasks.reverse().map((t) => [t.threadId, t])).values(),
  ].reverse();
}

function toHomeThread(
  thread: EmailThread,
  {
    userEmail,
    labelNames,
    skip,
  }: {
    userEmail: string;
    labelNames: Map<string, string>;
    skip: (string | undefined)[];
  },
): HomeThread | null {
  // An unsent draft isn't part of the conversation yet; it would show as the
  // newest message, from the user.
  const messages = thread.messages.filter(
    (m) => !m.labelIds?.includes("DRAFT"),
  );
  const latest = messages.at(-1);
  if (!latest) return null;
  // Show who the conversation is with: the latest sender who isn't the user,
  // or the first recipient when the user wrote last.
  const other =
    messages.findLast(
      (m) =>
        extractEmailAddress(m.headers.from).toLowerCase() !==
        userEmail.toLowerCase(),
    ) ?? null;
  const counterpart = other
    ? other.headers.from
    : (splitRecipientList(latest.headers.to)[0] ?? latest.headers.to);
  const labelIds = new Set(messages.flatMap((m) => m.labelIds ?? []));
  const tag = [...labelIds]
    .filter((id) => !skip.includes(id))
    .map((id) => labelNames.get(id))
    .find(
      (name): name is string =>
        !!name &&
        !HIDDEN_TAGS.has(name.toLowerCase()) &&
        !HANDLED_LABELS.includes(name),
    );
  const preview = (other ?? latest).snippet || thread.snippet || "";
  const unread = labelIds.has("UNREAD");

  return {
    threadId: thread.id,
    fromName:
      extractNameFromEmail(counterpart) || extractEmailAddress(counterpart),
    fromEmail: extractEmailAddress(counterpart),
    subject: (
      latest.headers.subject ||
      latest.subject ||
      "(no subject)"
    ).replace(/^((re|fwd?):\s*)+/i, ""),
    preview,
    at: new Date(getMessageTimestamp(latest)).toISOString(),
    tag: tag ?? handledTag(labelIds, labelNames),
    priority: priorityOf({
      preview: `${latest.headers.subject} ${preview}`,
      unread,
      tag,
    }),
    unread,
    messageId: latest.id,
    ...(latest.headers["message-id"]
      ? { rfcMessageId: latest.headers["message-id"] }
      : {}),
    starred: labelIds.has("STARRED"),
    inInbox: labelIds.has("INBOX"),
  };
}

/** High: unread with a deadline, or a customer. Medium: unread. Low: the rest. */
export function priorityOf({
  preview,
  unread,
  tag,
}: {
  preview: string;
  unread: boolean;
  tag?: string;
}): Priority {
  if ((unread && URGENT.test(preview)) || (tag && /customer|vip/i.test(tag)))
    return "high";
  if (unread) return "medium";
  return "low";
}

function handledTag(labelIds: Set<string>, labelNames: Map<string, string>) {
  return (
    [...labelIds]
      .map((id) => labelNames.get(id))
      .find((name) => name && HANDLED_LABELS.includes(name)) ?? undefined
  );
}

function findLabel(labels: EmailLabel[], name: string) {
  const wanted = name.trim().toLowerCase();
  return labels.find((l) => l.name.trim().toLowerCase() === wanted);
}

function humanize(value: string) {
  const s = value.toLowerCase().replace(/_/g, " ");
  return s.charAt(0).toUpperCase() + s.slice(1);
}

export type HomeLane = "needsYou" | "waiting" | "alsoInInbox";
type Pending = { ok: false; pending: boolean };
type LaneResult<T> = { ok: true; value: T } | Pending;
const PENDING: Pending = { ok: false, pending: true };
// A lane Gmail failed for another reason isn't asked for again on its own,
// since that wouldn't change the answer; the page says it didn't load.
const FAILED: Pending = { ok: false, pending: false };

async function withinBudget<T>(
  work: Promise<T>,
  deadline: number,
): Promise<LaneResult<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<Pending>((resolve) => {
    timer = setTimeout(
      () => resolve(PENDING),
      Math.max(0, deadline - Date.now()),
    );
  });
  try {
    return await Promise.race([
      work.then((value) => ({ ok: true as const, value })),
      late,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

function isString(x: string | undefined): x is string {
  return typeof x === "string";
}

function isDefined<T>(x: T | null): x is T {
  return x !== null;
}
