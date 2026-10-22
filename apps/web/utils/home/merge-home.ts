import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import type { AgentTask, HomeLane, HomeThread } from "@/utils/home/get-home";
import type { TodayHomeData } from "@/utils/home/keep-shown-lanes";
import type { MeetingNews } from "@/utils/home/meeting-news";
import type { NextUpItem } from "@/utils/home/next-up";
import {
  HOME_LANE_LIMIT,
  MEETING_NEWS_SHOWN,
  MINUTES_PER_REPLY,
  NEXT_UP_SHOWN,
  PRIORITY_ORDER,
  sortByDue,
} from "@/utils/home/today-constants";

// The browser merges, so this file stays free of server imports.

const LANES: HomeLane[] = ["needsYou", "waiting", "alsoInInbox", "reading"];

export type TodayAccount = { id: string; email: string };

export type TodayThread = HomeThread & {
  /** Across accounts: the mailbox the row's actions and links go to. */
  account?: TodayAccount;
  /** The same conversation in the user's other mailboxes, shown once. */
  alsoIn?: TodayAccount[];
};

export type TodayAgentTask = AgentTask & { account?: TodayAccount };

/** What Today shows, for one account or merged across several. */
export type TodayData = Omit<
  TodayHomeData,
  | "needsYou"
  | "waiting"
  | "alsoInInbox"
  | "reading"
  | "agentTasks"
  | "cue"
  | "today"
  // Label and thread ids are each mailbox's own, so they aren't merged.
  | "handledLabelIds"
  | "newsletterThreadIds"
> & {
  needsYou: TodayThread[];
  waiting: TodayThread[];
  alsoInInbox: TodayThread[];
  reading: TodayThread[];
  agentTasks: TodayAgentTask[];
  /** Across accounts, the mailbox each notice is about. */
  cue: GetHomeResponse["cue"] & {
    replyTrackingOffAccount?: TodayAccount;
    readingAccount?: TodayAccount;
  };
  today: Omit<GetHomeResponse["today"], "filedLabel"> & {
    filedLabel:
      | (NonNullable<GetHomeResponse["today"]["filedLabel"]> & {
          accountId?: string;
        })
      | null;
  };
};

/** One account's Today as it stands in the browser. */
export type AccountHome = {
  account: TodayAccount;
  data?: TodayHomeData;
  error?: unknown;
  /** A lane stayed pending through every refresh. */
  gaveUp: boolean;
};

/**
 * Today across accounts, as one Today: each lane is every account's rows in
 * the order one account's would be, capped the same, with each row naming
 * its account. A conversation in two of the user's mailboxes shows once, in
 * the lane that asks most of the user, and says where else it is.
 *
 * An account still loading leaves every lane pending, and one that failed
 * leaves them failed and is listed in `failedAccountIds`, so Today never
 * says all is clear while an account's mail is unknown.
 */
export function mergeHomeData(accounts: AccountHome[]): {
  data: TodayData | null;
  failedAccountIds: string[];
} {
  const loaded = accounts.filter(
    (entry): entry is AccountHome & { data: TodayHomeData } =>
      Boolean(entry.data),
  );
  const pending = new Set<HomeLane>();
  const failed = new Set<HomeLane>();
  const failedAccountIds: string[] = [];
  for (const entry of accounts) {
    if (!entry.data) {
      for (const lane of LANES)
        (entry.error !== undefined ? failed : pending).add(lane);
      if (entry.error !== undefined) failedAccountIds.push(entry.account.id);
      continue;
    }
    for (const lane of entry.data.failed) failed.add(lane);
    // Past the last refresh a pending lane would load forever.
    for (const lane of entry.data.pending)
      (entry.gaveUp ? failed : pending).add(lane);
    if (entry.data.failed.length || (entry.gaveUp && entry.data.pending.length))
      failedAccountIds.push(entry.account.id);
  }
  if (!loaded.length) return { data: null, failedAccountIds };

  const tagged = (lane: HomeLane) =>
    loaded.flatMap(({ account, data }) =>
      data[lane].map((thread): TodayThread => ({ ...thread, account })),
    );
  const byDate = (a: TodayThread, b: TodayThread) => b.at.localeCompare(a.at);
  // Rows a lane shows, by conversation. A row past a lane's cap isn't shown,
  // so it never hides the conversation's copy in another account.
  const shown = new Map<string, TodayThread>();
  const lane = (threads: TodayThread[]) => {
    const rows: TodayThread[] = [];
    let more = false;
    for (const thread of threads) {
      const key = todayConversationKey(thread);
      const first = shown.get(key);
      // Within one mailbox Today shows what one account's Today shows.
      const sameMailbox =
        first && (!thread.account || first.account?.id === thread.account.id);
      if (first && !sameMailbox) {
        if (!first.alsoIn?.some(({ id }) => id === thread.account?.id))
          first.alsoIn = [
            ...(first.alsoIn ?? []),
            ...(thread.account ? [thread.account] : []),
          ];
        continue;
      }
      if (rows.length === HOME_LANE_LIMIT) {
        more = true;
        break;
      }
      // A copy, so noting "also in" doesn't change SWR's own data.
      const row = { ...thread };
      if (!first) shown.set(key, row);
      rows.push(row);
    }
    return { rows, more };
  };

  const needsYou = lane(
    tagged("needsYou").sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] || byDate(a, b),
    ),
  );
  const waiting = lane(tagged("waiting").sort(byDate));
  const alsoInInbox = lane(tagged("alsoInInbox").sort(byDate));
  const readingLane = lane(tagged("reading").sort(byDate));

  const replyTrackingOff = loaded.find(({ data }) => !data.cue.replyTracking);
  const reading = loaded.find(({ data }) => !data.cue.hasReadMail);
  const filedAccounts = loaded.filter(({ data }) => data.today.filed > 0);
  const onlyFiled = filedAccounts.length === 1 ? filedAccounts[0] : undefined;
  const nextEvents = loaded
    .map(({ data }) => data.calendar.next)
    .filter((next) => next !== null)
    .sort((a, b) => a.at.localeCompare(b.at));

  const lanes = {
    needsYou: needsYou.rows,
    waiting: waiting.rows,
    alsoInInbox: alsoInInbox.rows,
    reading: readingLane.rows,
  };

  return {
    data: {
      ...lanes,
      pending: LANES.filter((lane) => pending.has(lane)),
      failed: LANES.filter((lane) => failed.has(lane)),
      stale: LANES.filter((lane) =>
        loaded.some(({ data }) => data.stale?.includes(lane)),
      ),
      // One account's copy from an earlier day leaves the day's counts unknown.
      earlierDay: loaded.some(({ data }) => data.earlierDay),
      agentTasks: loaded.flatMap(({ account, data }) =>
        data.agentTasks.map((task) => ({ ...task, account })),
      ),
      cue: {
        aiAccess: loaded.every(({ data }) => data.cue.aiAccess),
        replyTracking: loaded.every(({ data }) => data.cue.replyTracking),
        hasReadMail: loaded.every(({ data }) => data.cue.hasReadMail),
        ...(replyTrackingOff
          ? { replyTrackingOffAccount: replyTrackingOff.account }
          : {}),
        ...(reading ? { readingAccount: reading.account } : {}),
      },
      today: {
        checked: sum(loaded.map(({ data }) => data.today.checked)),
        filed: sum(loaded.map(({ data }) => data.today.filed)),
        // Where filed mail went is one place only within one mailbox.
        filedLabel: onlyFiled?.data.today.filedLabel
          ? {
              ...onlyFiled.data.today.filedLabel,
              accountId: onlyFiled.account.id,
            }
          : null,
      },
      calendar: {
        connected: loaded.some(({ data }) => data.calendar.connected),
        // Every account reads the user's calendars: one that couldn't, or
        // found a meeting, means the calendar isn't known to be clear.
        clearThroughTomorrow:
          loaded.some(({ data }) => data.calendar.connected) &&
          loaded.every(
            ({ data }) =>
              !data.calendar.connected || data.calendar.clearThroughTomorrow,
          ),
        next: nextEvents[0] ?? null,
      },
      nextUp: mergeNextUp(loaded.map(({ data }) => data.nextUp)),
      suggestion:
        loaded.find(({ data }) => data.suggestion)?.data.suggestion ?? null,
      stats: {
        needsYou: lanes.needsYou.length,
        estimatedMinutes: lanes.needsYou.length * MINUTES_PER_REPLY,
        agentWorking: sum(loaded.map(({ data }) => data.stats.agentWorking)),
        waiting: lanes.waiting.length,
        // Lists are capped, so a full one means "at least this many".
        needsYouCapped:
          needsYou.more || loaded.some(({ data }) => data.stats.needsYouCapped),
        waitingCapped:
          waiting.more || loaded.some(({ data }) => data.stats.waitingCapped),
        readingCapped:
          readingLane.more ||
          loaded.some(({ data }) => data.stats.readingCapped),
      },
    },
    failedAccountIds,
  };
}

/**
 * Every account's next meetings and deadlines, each once. Two calendars
 * holding the same meeting give it the same start, end and title; deadlines
 * come from apps connected for the user, so each account reports the same
 * ones.
 */
export function mergeNextUp(lists: NextUpItem[][]): NextUpItem[] {
  const seen = new Set<string>();
  const items: NextUpItem[] = [];
  for (const item of lists.flat()) {
    const key =
      item.kind === "event"
        ? `event|${item.at}|${item.endAt ?? ""}|${normalizeTitle(item.title)}`
        : `deadline|${item.source}|${item.at}|${normalizeTitle(item.title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  return sortByDue(items).slice(0, NEXT_UP_SHOWN);
}

/**
 * Every account's meeting news, each organization once, for its first
 * meeting, as one account's would be.
 */
export function mergeMeetingNews(lists: MeetingNews[][]): MeetingNews[] {
  const seen = new Set<string>();
  return lists
    .flat()
    .sort((a, b) => a.startTime.localeCompare(b.startTime))
    .filter((meeting) => {
      const key = meeting.organization.trim().toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, MEETING_NEWS_SHOWN);
}

/**
 * The same conversation in two mailboxes has its own thread id in each, but
 * its newest message carries one Message-ID header everywhere.
 */
export function todayConversationKey(thread: TodayThread) {
  const messageId = normalizeInternetMessageId(thread.rfcMessageId);
  return messageId
    ? `message:${messageId}`
    : `thread:${thread.account?.id ?? ""}:${thread.threadId}`;
}

function normalizeTitle(title: string) {
  return title.trim().replace(/\s+/g, " ").toLowerCase();
}

function sum(values: number[]) {
  return values.reduce((total, value) => total + value, 0);
}
