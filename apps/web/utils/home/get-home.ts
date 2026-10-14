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
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { getTrackedThreads } from "@/utils/reply-tracker/tracked-threads";
import { getRuleLabel } from "@/utils/rule/consts";
import {
  getUserTier,
  hasAiAccess,
  isPremiumRecord,
  premiumEntitlementSelect,
} from "@/utils/premium";

const LIST_LIMIT = 10;
const HANDLED_WINDOW_DAYS = 7;
// Older pending drafts were most likely deleted in the mail app, and a rule
// still "applying" after this long has crashed; neither is work in progress.
const DRAFT_WINDOW_DAYS = 7;
const RUNNING_WINDOW_MINUTES = 30;
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
// A rough per-email estimate, shown with a "~" so nobody reads it as measured.
const MINUTES_PER_REPLY = 3;
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
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}) {
  const labels = await emailProvider.getLabels();
  const labelId = (name: string) => findLabel(labels, name)?.id;
  const labelNames = new Map(labels.map((l) => [l.id, l.name]));

  const toReplyId = labelId(getRuleLabel(SystemType.TO_REPLY));
  const awaitingId = labelId(getRuleLabel(SystemType.AWAITING_REPLY));
  const handledIds = HANDLED_LABELS.map(labelId).filter(isString);
  const since = new Date(now.getTime() - HANDLED_WINDOW_DAYS * 86_400_000);

  const list = (
    query: Parameters<EmailProvider["getThreadsWithQuery"]>[0]["query"],
    label: string,
  ) =>
    emailProvider
      .getThreadsWithQuery({
        query,
        maxResults: LIST_LIMIT,
        messageFormat: "metadata",
      })
      .then((r) => r.threads)
      .catch((error) => {
        // An empty lane would read as "nothing here"; the client retries.
        if (isGmailCallDeferredError(error)) throw error;
        logger.warn("Failed to list home threads", { label, error });
        return [] as EmailThread[];
      });

  // Reply tracking lives in Cue's database, so these lanes don't depend on Cue
  // labelling anything in the mailbox.
  const tracked = (
    type: ThreadTrackerType,
    label: string,
    inboxOnly: boolean,
  ) =>
    getTrackedThreads({
      emailAccountId,
      emailProvider,
      type,
      limit: LIST_LIMIT,
      inboxOnly,
    }).catch((error) => {
      if (isGmailCallDeferredError(error)) throw error;
      logger.warn("Failed to list tracked home threads", { label, error });
      return [] as EmailThread[];
    });

  const [needsYou, waiting, handledByLabel, inbox, agentTasks, cue] =
    await Promise.all([
      // An archived conversation is off the user's plate even before they reply.
      tracked(ThreadTrackerType.NEEDS_REPLY, "needs-you", true),
      tracked(ThreadTrackerType.AWAITING, "waiting", false),
      // One query per label: the EmailProvider interface has no "any of these labels".
      Promise.all(
        handledIds.map((id) =>
          list({ labelIds: [id], after: since }, "handled"),
        ),
      ),
      // Everything still in the inbox, so nothing is only reachable through AI triage.
      list({ labelIds: ["INBOX"] }, "inbox"),
      getAgentTasks({ emailAccountId, now }),
      getCueStatus(emailAccountId),
    ]);
  const handled = uniqueByThreadId(handledByLabel.flat());
  // Each thread shows once on Today: sorted mail has its own section.
  const shownIds = new Set([...needsYou, ...handled].map((t) => t.id));

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

  return {
    needsYou: needsYouRows,
    waiting: waiting.map(toRow).filter(isDefined),
    handled: handled.map(toRow).filter(isDefined),
    // Where filed mail went, so the user can check what was moved out of the way.
    handledLabels: handledIds
      .map((id, index) => ({
        labelId: id,
        name: labelNames.get(id) ?? "",
        count: handledByLabel[index]?.length ?? 0,
        // Each label's list is capped, so a full one means "at least".
        capped: (handledByLabel[index]?.length ?? 0) >= LIST_LIMIT,
      }))
      .filter((label) => label.count > 0),
    alsoInInbox: inbox
      .filter((t) => !shownIds.has(t.id))
      .map(toRow)
      .filter(isDefined),
    agentTasks,
    // Whether an empty lane means "nothing there" or "nobody has looked".
    cue,
    stats: {
      needsYou: needsYouRows.length,
      estimatedMinutes: needsYouRows.length * MINUTES_PER_REPLY,
      agentWorking: agentTasks.length,
      waiting: waiting.length,
      handled: handled.length,
      handledWindowDays: HANDLED_WINDOW_DAYS,
      // Lists are capped, so a full one means "at least this many".
      needsYouCapped: needsYou.length >= LIST_LIMIT,
      waitingCapped: waiting.length >= LIST_LIMIT,
      handledCapped: handled.length >= LIST_LIMIT,
    },
  };
}

const PRIORITY_ORDER: Record<Priority, number> = { high: 0, medium: 1, low: 2 };

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
        rules: {
          where: { systemType: SystemType.TO_REPLY },
          select: { enabled: true },
        },
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
    replyTracking: account?.rules.some((rule) => rule.enabled) ?? false,
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
        draftStatus: DraftEmailStatus.PENDING,
        draftId: { not: null },
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
      title: d.subject ? `Reply draft: ${d.subject}` : "Reply draft",
      detail: "Draft ready for your review",
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

function uniqueByThreadId(threads: EmailThread[]) {
  return [...new Map(threads.map((t) => [t.id, t])).values()];
}

function isString(x: string | undefined): x is string {
  return typeof x === "string";
}

function isDefined<T>(x: T | null): x is T {
  return x !== null;
}
