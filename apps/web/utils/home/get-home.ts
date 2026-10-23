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
import { findReadingLabelId } from "@/utils/label/reading-label";
import { mapWithConcurrency } from "@/utils/async";
import { getCueNewsletterThreadIds } from "@/utils/split-inbox/cue-membership.server";
import { getThreadTimestamp } from "@/utils/threads/sort";
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
// The newest conversations Cue sorted as newsletters that Today considers.
// The server and the browser's own inbox leave out the same ones, which this
// bounds in the answer too.
const TODAY_NEWSLETTER_LIMIT = 500;
// Unread inbox conversations one id-only listing (one Gmail threads.list)
// checks Cue's newsletters against. Fuller than that, some may be missed, and
// Reading says it holds more.
const UNREAD_SCAN_LIMIT = 500;
const READING_THREAD_CONCURRENCY = 5;
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
  requested = true,
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
  /**
   * False for a reload Today started by itself (a change notice or a retry
   * of a pending lane): it then refreshes at sync's priority, as the rest of
   * the app keeps itself current, rather than ahead of background work.
   */
  requested?: boolean;
}) {
  // Today waits on Gmail for the rows it shows, behind whatever else the
  // account is doing. A lane that can't be served in time comes back pending,
  // for the client to fetch again, rather than holding up or failing the rest.
  const deadline = Date.now() + HOME_BUDGET_MS;
  // Someone asked for the page: its reads go ahead of sync and background
  // work, which also hold back while it loads, as they do for an assistant
  // turn. Its many small reads would otherwise get only what sync leaves.
  const releaseDemand = requested
    ? holdGmailInteractiveDemand(emailAccountId, HOME_BUDGET_MS)
    : Promise.resolve(() => undefined);
  const priority = requested ? "interactive" : "sync";
  const gmail = <T>(lane: HomeLane | "labels", work: () => Promise<T>) =>
    withinBudget(
      runWithGmailQuota({ priority, maxTotalWaitMs: HOME_BUDGET_MS }, work),
      deadline,
    ).catch((error): Pending => {
      if (isGmailCallDeferredError(error)) return PENDING;
      logger.warn("Failed to load home lane", { lane, error });
      return FAILED;
    });

  const since = now.getTime() - HANDLED_WINDOW_DAYS * 86_400_000;
  const labelsLoad = gmail("labels", () => emailProvider.getLabels());
  // Cue sorts without labelling the mailbox by default, so its own records
  // say which conversations are newsletters as well as the label does.
  const cueNewslettersLoad = getCueNewsletterThreadIds({
    emailAccountId,
    since: new Date(since),
    limit: TODAY_NEWSLETTER_LIMIT,
  }).catch((error) => {
    logger.warn("Failed to load Cue's newsletters for home", { error });
    return [] as string[];
  });
  // Unread newsletters still in the inbox, which the rest of the inbox
  // leaves out as filed mail, so they're bundled in one calm row instead.
  const readingLoad = Promise.all([labelsLoad, cueNewslettersLoad]).then(
    ([labels, cueThreadIds]): Promise<LaneResult<ReadingThreads>> => {
      // As with the rest of the inbox, filed mail can't be told apart
      // without the labels.
      if (!labels.ok) return Promise.resolve(PENDING);
      const readingLabelId = findReadingLabelId(labels.value);
      if (!readingLabelId && !cueThreadIds.length)
        return Promise.resolve({ ok: true, value: NO_READING });
      return gmail("reading", () =>
        getReadingThreads({
          emailProvider,
          readingLabelId,
          cueThreadIds,
          after: new Date(since),
          limit: LIST_LIMIT,
          deadline,
          logger,
        }),
      );
    },
  );

  const [
    labelsResult,
    readingResult,
    needsYouResult,
    waitingResult,
    inboxResult,
    agentTasks,
    cue,
    today,
    nextUp,
    replySettings,
  ] = await Promise.all([
    labelsLoad,
    readingLoad,
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
    ["reading", readingResult],
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
  const readingId = findReadingLabelId(labels);
  // Each thread shows once on Today. Recently filed mail is Cue's to handle,
  // so it isn't repeated under the rest of the inbox either.
  const shownIds = new Set(needsYou.map((t) => t.id));
  // Cue's newsletters are checked by listing unread mail since `since`; one
  // missing from that listing is left out only if the inbox's own copy also
  // shows it read through and recent, so a test on either side that the
  // other doesn't make never hides unread mail.
  const isReadAndRecent = (thread: EmailThread) =>
    thread.messages.every((m) => !m.labelIds?.includes("UNREAD")) &&
    thread.messages.some((m) => getMessageTimestamp(m) >= since);
  const isRecentlyFiled = (thread: EmailThread, ids: ReadonlySet<string>) =>
    thread.messages.some(
      (m) =>
        getMessageTimestamp(m) >= since &&
        m.labelIds?.some((id) => ids.has(id)),
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
  // Exactly the newsletters the rest of the inbox leaves out as filed: by
  // the label, or by Cue's own sorting, each conversation once.
  const readingIds = new Set(readingId ? [readingId] : []);
  const readingLoaded = readingResult.ok ? readingResult.value : NO_READING;
  const cueNewsletters = new Set(readingLoaded.checkedCueThreadIds);
  const reading = readingLoaded.threads;
  const readingRows = reading
    .filter(
      (t) =>
        !shownIds.has(t.id) &&
        (cueNewsletters.has(t.id) || isRecentlyFiled(t, readingIds)),
    )
    .map(toRow)
    .filter(isDefined)
    .filter((row) => row.unread && row.inInbox);
  // Outlook's inbox listing names a message's categories only once it knows
  // them, so what Reading shows is left out by thread too.
  const readingThreadIds = new Set(readingRows.map((row) => row.threadId));
  const inboxRows = lane(inbox)
    .filter(
      (t) =>
        !shownIds.has(t.id) &&
        !readingThreadIds.has(t.id) &&
        !(cueNewsletters.has(t.id) && isReadAndRecent(t)) &&
        !isRecentlyFiled(t, handledIds),
    )
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
    /** Unread newsletters in the inbox, which Today bundles in one row. */
    reading: readingRows,
    /**
     * The account's labels for mail Cue files without asking, so the
     * browser's own inbox can leave recently filed mail out as this does.
     */
    handledLabelIds,
    /**
     * Conversations Cue sorted as newsletters lately, by id, which the
     * browser's own inbox leaves out as it does mail under those labels.
     */
    newsletterThreadIds: readingLoaded.checkedCueThreadIds,
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
      readingCapped: reading.length >= LIST_LIMIT || readingLoaded.capped,
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
  const [account, hasReadMail] = await Promise.all([
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
    hasCueReadMail(emailAccountId),
  ]);
  const premium = account?.user.premium;

  return {
    aiAccess:
      isPremiumRecord(premium) &&
      hasAiAccess(getUserTier(premium), !!account?.user.aiApiKey),
    replyTracking: isReplyTrackingOn(account?.rules),
    hasReadMail,
  };
}

/**
 * Whether Cue has read any of this mailbox: run a rule on a message or
 * tracked a conversation. Until then Needs reply can only be empty, and Cue
 * has filed nothing.
 */
export async function hasCueReadMail(emailAccountId: string) {
  const [firstRun, firstTracker] = await Promise.all([
    prisma.executedRule.findFirst({
      where: { emailAccountId },
      select: { id: true },
    }),
    prisma.threadTracker.findFirst({
      where: { emailAccountId },
      select: { id: true },
    }),
  ]);
  return Boolean(firstRun || firstTracker);
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

/**
 * Unread newsletters still in the inbox, newest first: those under the
 * Newsletter label, and those Cue sorted as newsletters in its own records
 * (most accounts, as Cue doesn't label the mailbox by default). A
 * conversation that is both shows once.
 *
 * Cue's are found by one id-only listing of unread inbox mail, so only its
 * unread newsletters are read in full, newest decision first and no more
 * than Reading lists. `checkedCueThreadIds` are those whose place is now
 * known (read in full, or listed as not unread): only those may be left out
 * of the rest of the inbox, so a newsletter that wasn't checked still shows.
 */
async function getReadingThreads({
  emailProvider,
  readingLabelId,
  cueThreadIds,
  after,
  limit,
  deadline,
  logger,
}: {
  emailProvider: EmailProvider;
  logger: Logger;
  readingLabelId: string | undefined;
  cueThreadIds: string[];
  after: Date;
  limit: number;
  /** Past it, no more reads start: the answer has gone without them. */
  deadline: number;
}): Promise<ReadingThreads> {
  const labelled = readingLabelId
    ? (
        await emailProvider.getThreadsWithQuery({
          query: { labelIds: [readingLabelId, "INBOX"], isUnread: true, after },
          maxResults: limit,
          messageFormat: "metadata",
        })
      ).threads
    : [];
  if (!cueThreadIds.length || Date.now() >= deadline)
    return { threads: labelled, checkedCueThreadIds: [], capped: false };

  const unread = await emailProvider
    .listUnreadInboxThreadIds({ after, maxResults: UNREAD_SCAN_LIMIT })
    .catch((error) => {
      // Gmail's budget is busy: the lane comes back pending, to ask again.
      if (isGmailCallDeferredError(error)) throw error;
      logger.warn("Failed to list unread inbox mail for Reading", { error });
      return null;
    });
  // Without the listing nothing is known of Cue's, so the labelled stand.
  if (!unread)
    return { threads: labelled, checkedCueThreadIds: [], capped: false };
  const unreadIds = new Set(unread.threadIds);
  const listingFull = unread.full;
  const labelledIds = new Set(labelled.map((thread) => thread.id));
  const hits = cueThreadIds.filter(
    (threadId) => unreadIds.has(threadId) && !labelledIds.has(threadId),
  );
  const toRead = hits.slice(0, Math.max(0, limit - labelled.length));
  const read = await mapWithConcurrency(
    toRead,
    READING_THREAD_CONCURRENCY,
    async (threadId) => {
      if (Date.now() >= deadline) return null;
      // A thread Gmail deferred, or that failed, is left unchecked: it stays
      // in the rest of the inbox rather than taking the lane with it.
      return emailProvider
        .getThread(threadId, { messageFormat: "metadata" })
        .catch(() => null);
    },
  );
  const found = read.filter(
    (thread): thread is EmailThread =>
      !!thread &&
      thread.messages.some((m) => m.labelIds?.includes("INBOX")) &&
      thread.messages.some((m) => m.labelIds?.includes("UNREAD")),
  );
  const readIds = new Set(
    read.flatMap((thread) => (thread ? [thread.id] : [])),
  );
  return {
    threads: [...labelled, ...found].sort(
      (a, b) => getThreadTimestamp(b) - getThreadTimestamp(a),
    ),
    checkedCueThreadIds: cueThreadIds.filter(
      (threadId) =>
        readIds.has(threadId) || (!listingFull && !unreadIds.has(threadId)),
    ),
    capped: hits.length > toRead.length || listingFull,
  };
}

type ReadingThreads = {
  threads: EmailThread[];
  checkedCueThreadIds: string[];
  capped: boolean;
};
const NO_READING: ReadingThreads = {
  threads: [],
  checkedCueThreadIds: [],
  capped: false,
};

export type HomeLane = "needsYou" | "waiting" | "alsoInInbox" | "reading";
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
