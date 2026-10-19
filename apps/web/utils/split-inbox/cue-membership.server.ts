import {
  ExecutedRuleStatus,
  SystemType,
  ThreadTrackerType,
} from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import { CONVERSATION_STATUS_TYPES } from "@/utils/reply-tracker/conversation-status-config";
import type {
  CueFilterValue,
  CueMembership,
} from "@/utils/split-inbox/cue-filter";

// Each list becomes one message predicate on the device, and Other excludes
// several at once, so every list stays well under the engine's id limit.
const MEMBERSHIP_LIMIT = 2000;
const READING_WINDOW_DAYS = 90;
const READING_SCAN_LIMIT = 5000;
const READING_TYPES: CueFilterValue[] = [
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
];

/**
 * Which messages Cue sorted into its own tabs, read from Cue's database rather
 * than mailbox labels. Needs reply is every conversation still waiting on the
 * user. Newsletter and Marketing follow what Cue last decided about each recent
 * conversation, so one that turned into a real exchange leaves Reading.
 */
export async function getCueMembership({
  emailAccountId,
  now = new Date(),
}: {
  emailAccountId: string;
  now?: Date;
}): Promise<CueMembership> {
  const [trackers, executions] = await Promise.all([
    prisma.threadTracker.findMany({
      where: {
        emailAccountId,
        type: ThreadTrackerType.NEEDS_REPLY,
        resolved: false,
      },
      select: { threadId: true, messageId: true },
      orderBy: { sentAt: "desc" },
      take: MEMBERSHIP_LIMIT,
    }),
    prisma.executedRule.findMany({
      where: {
        emailAccountId,
        status: ExecutedRuleStatus.APPLIED,
        createdAt: {
          gte: new Date(now.getTime() - READING_WINDOW_DAYS * 86_400_000),
        },
        rule: {
          systemType: { in: [...READING_TYPES, ...CONVERSATION_STATUS_TYPES] },
        },
      },
      select: {
        threadId: true,
        messageId: true,
        rule: { select: { systemType: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: READING_SCAN_LIMIT,
    }),
  ]);

  const membership: CueMembership = {
    TO_REPLY: trackers.map((tracker) => tracker.messageId),
    NEWSLETTER: [],
    MARKETING: [],
  };

  const decisions = latestReadingDecisions(
    executions,
    new Set(trackers.map((tracker) => tracker.threadId)),
  );
  for (const { messageId, type } of decisions) {
    if (membership[type].length < MEMBERSHIP_LIMIT)
      membership[type].push(messageId);
  }

  return membership;
}

/**
 * Whether Cue sorted a thread into Reading (Newsletter or Marketing), by the
 * same rule as the Reading tabs. Null when it didn't, or hasn't decided yet.
 */
export async function getCueReadingType({
  emailAccountId,
  threadId,
}: {
  emailAccountId: string;
  threadId: string;
}): Promise<CueFilterValue | null> {
  const [awaitingReply, executions] = await Promise.all([
    prisma.threadTracker.findFirst({
      where: {
        emailAccountId,
        threadId,
        type: ThreadTrackerType.NEEDS_REPLY,
        resolved: false,
      },
      select: { threadId: true },
    }),
    prisma.executedRule.findMany({
      where: {
        emailAccountId,
        threadId,
        status: ExecutedRuleStatus.APPLIED,
        rule: {
          systemType: { in: [...READING_TYPES, ...CONVERSATION_STATUS_TYPES] },
        },
      },
      select: {
        threadId: true,
        messageId: true,
        rule: { select: { systemType: true } },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 1,
    }),
  ]);
  const [decision] = latestReadingDecisions(
    executions,
    new Set(awaitingReply ? [threadId] : []),
  );
  return decision?.type ?? null;
}

/**
 * Cue's latest decision per thread decides Reading, from executions newest
 * first. Marking a newsletter as needing a reply is a correction: it leaves
 * Reading.
 */
function latestReadingDecisions(
  executions: {
    threadId: string;
    messageId: string;
    rule: { systemType: SystemType | null } | null;
  }[],
  awaitingReplyThreadIds: Set<string>,
) {
  const seenThreadIds = new Set(awaitingReplyThreadIds);
  const decisions: { messageId: string; type: CueFilterValue }[] = [];
  for (const execution of executions) {
    if (seenThreadIds.has(execution.threadId)) continue;
    seenThreadIds.add(execution.threadId);
    const systemType = execution.rule?.systemType;
    const type = READING_TYPES.find((candidate) => candidate === systemType);
    if (type) decisions.push({ messageId: execution.messageId, type });
  }
  return decisions;
}
