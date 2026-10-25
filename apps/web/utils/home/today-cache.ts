import type { GetHomeResponse } from "@/app/api/user/home/route";
import { createBrowserCache } from "@/utils/browser-cache";
import type { TodayHomeData } from "@/utils/home/keep-shown-lanes";
import { MINUTES_PER_REPLY } from "@/utils/home/today-constants";

/**
 * Today's last answer, kept in this browser so Today opens on it at once
 * while a fresh one loads from Gmail, which can take seconds. It holds what
 * Today shows: senders, subjects and short previews, like the local mail
 * store already does on this device. It lives in the browser cache, so it is
 * the signed-in user's only, and is cleared on sign-out and when the account
 * is removed.
 */

/** "Also in your inbox" shows this many rows. */
export const ALSO_IN_INBOX_LIMIT = 5;

// A returning user is shown what Today last said, even from days ago, while
// it refreshes: an older copy is still closer than an empty page. Past this
// it says too little about the inbox now to be worth showing.
const KEPT_FOR_MS = 3 * 24 * 60 * 60 * 1000;
// A row shows one line of preview; the rest would only take up storage.
const PREVIEW_LENGTH = 140;
const ENTRY_KEY = "home";
// Bumped whenever Today's answer changes shape: a copy saved by an earlier
// deploy is ignored rather than read as this one.
// 4: meetings-only Next up (deadlines are never saved), next meeting ids, and the Reading lane.
const SAVED_VERSION = 4;
// What an earlier day's copy says of Cue: no notice and no AI actions, as it
// is never shown until the fresh answer says what Cue can do now.
const UNKNOWN_CUE: GetHomeResponse["cue"] = {
  aiAccess: false,
  replyTracking: true,
  hasReadMail: true,
};

type Saved = {
  version: number;
  savedAt: number;
  /** The time zone Today's answer counted "today" in. */
  timeZone: string;
  data: GetHomeResponse;
};

const savedToday = createBrowserCache<Saved>({
  name: "today",
  ttlMs: KEPT_FOR_MS,
  maxEntries: 1,
  maxBytes: 256 * 1024,
});

/**
 * Today's saved copy for this account, less meetings and deadlines already
 * past. One from an earlier day in `timeZone` keeps only its conversations
 * and is marked `earlierDay`: its counts, Cue's status and the assistant's
 * tasks were that day's.
 */
export function readCachedToday({
  emailAccountId,
  timeZone,
  now = Date.now(),
}: {
  emailAccountId: string;
  /** The zone Today's answers count "today" in, as the server is asked. */
  timeZone: string;
  now?: number;
}): TodayHomeData | undefined {
  if (!emailAccountId) return;
  try {
    const saved = savedToday.get(emailAccountId, ENTRY_KEY, now);
    if (!isSaved(saved)) return;
    const data = withoutPast(saved.data, now);
    if (
      saved.timeZone === timeZone &&
      dayOf(saved.savedAt, timeZone) === dayOf(now, timeZone)
    )
      return data;
    return {
      ...data,
      earlierDay: true,
      agentTasks: [],
      cue: UNKNOWN_CUE,
      today: { checked: 0, filed: 0, filedLabel: null },
      stats: { ...data.stats, agentWorking: 0 },
    };
  } catch {
    // A copy this build can't read only costs the instant first paint.
    return;
  }
}

/** Saves Today when every lane loaded: a pending lane would read as empty. */
export function writeCachedToday({
  emailAccountId,
  timeZone,
  data,
  now = Date.now(),
}: {
  emailAccountId: string;
  timeZone: string;
  data: TodayHomeData;
  now?: number;
}) {
  if (!emailAccountId || data.earlierDay) return;
  if (data.pending.length || data.failed.length || data.stale?.length) return;
  savedToday.set(
    emailAccountId,
    ENTRY_KEY,
    { version: SAVED_VERSION, savedAt: now, timeZone, data: toStored(data) },
    now,
  );
}

/**
 * Takes conversations the user archived, deleted or snoozed out of the saved
 * copy, so they don't come back on the next visit before Today refreshes.
 */
export function removeFromCachedToday(
  emailAccountId: string,
  threadIds: string[],
  now = Date.now(),
) {
  if (!emailAccountId || !threadIds.length) return;
  const saved = savedToday.get(emailAccountId, ENTRY_KEY, now);
  if (!isSaved(saved)) return;
  const gone = new Set(threadIds);
  const keep = <T extends { threadId: string }>(rows: T[]) =>
    rows.filter((row) => !gone.has(row.threadId));
  const data = {
    ...saved.data,
    needsYou: keep(saved.data.needsYou),
    waiting: keep(saved.data.waiting),
    alsoInInbox: keep(saved.data.alsoInInbox),
    reading: keep(saved.data.reading),
  };
  data.stats = {
    ...data.stats,
    needsYou: data.needsYou.length,
    estimatedMinutes: data.needsYou.length * MINUTES_PER_REPLY,
    waiting: data.waiting.length,
  };
  // Keeps when it was saved: its rows are no newer for this.
  savedToday.set(emailAccountId, ENTRY_KEY, { ...saved, data }, saved.savedAt);
}

function toStored({
  stale: _stale,
  earlierDay: _earlierDay,
  ...data
}: TodayHomeData): GetHomeResponse {
  const shorten = <T extends { preview: string }>(rows: T[]) =>
    rows.map((row) =>
      row.preview.length > PREVIEW_LENGTH
        ? { ...row, preview: row.preview.slice(0, PREVIEW_LENGTH) }
        : row,
    );
  return {
    ...data,
    needsYou: shorten(data.needsYou),
    waiting: shorten(data.waiting),
    alsoInInbox: shorten(data.alsoInInbox.slice(0, ALSO_IN_INBOX_LIMIT)),
    reading: shorten(data.reading),
  };
}

// Whatever the day, a meeting that started or a deadline that passed isn't
// next any more.
function withoutPast(data: GetHomeResponse, now: number): GetHomeResponse {
  const next = data.calendar.next;
  return {
    ...data,
    calendar: {
      ...data.calendar,
      next: next && Date.parse(next.at) > now ? next : null,
      // A meeting may have been booked since: only a fresh read says clear.
      clearThroughTomorrow: false,
    },
    nextUp: data.nextUp.filter(
      (item) => Date.parse(item.endAt ?? item.at) > now,
    ),
  };
}

/** Whether a stored copy has the shape this build reads. */
function isSaved(saved: Saved | undefined): saved is Saved {
  if (!saved || saved.version !== SAVED_VERSION) return false;
  if (typeof saved.savedAt !== "number" || typeof saved.timeZone !== "string")
    return false;
  const data = saved.data as Partial<GetHomeResponse> | undefined;
  return Boolean(
    data &&
      Array.isArray(data.needsYou) &&
      Array.isArray(data.waiting) &&
      Array.isArray(data.alsoInInbox) &&
      Array.isArray(data.reading) &&
      Array.isArray(data.pending) &&
      Array.isArray(data.failed) &&
      Array.isArray(data.agentTasks) &&
      Array.isArray(data.nextUp) &&
      data.cue &&
      data.today &&
      data.calendar &&
      data.stats,
  );
}

/** The calendar day of `ms` in `timeZone`, as Today's answer counts it. */
function dayOf(ms: number, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(ms);
}
