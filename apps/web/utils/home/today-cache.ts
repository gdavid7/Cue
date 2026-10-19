import type { GetHomeResponse } from "@/app/api/user/home/route";
import { createBrowserCache } from "@/utils/browser-cache";
import type { TodayHomeData } from "@/utils/home/keep-shown-lanes";

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

type Saved = { savedAt: number; data: GetHomeResponse };

const savedToday = createBrowserCache<Saved>({
  name: "today",
  ttlMs: KEPT_FOR_MS,
  maxEntries: 1,
  maxBytes: 256 * 1024,
});

/**
 * Today's saved copy for this account. One from an earlier day keeps its
 * conversations but not that day's counts or meetings already past.
 */
export function readCachedToday({
  emailAccountId,
  now = Date.now(),
}: {
  emailAccountId: string;
  now?: number;
}): GetHomeResponse | undefined {
  if (!emailAccountId) return;
  const saved = savedToday.get(emailAccountId, ENTRY_KEY, now);
  if (!saved?.data) return;
  return sameDay(saved.savedAt, now)
    ? saved.data
    : withoutPastDay(saved.data, now);
}

/** Saves Today when every lane loaded: a pending lane would read as empty. */
export function writeCachedToday({
  emailAccountId,
  data,
  now = Date.now(),
}: {
  emailAccountId: string;
  data: TodayHomeData;
  now?: number;
}) {
  if (!emailAccountId) return;
  if (data.pending.length || data.failed.length || data.stale?.length) return;
  savedToday.set(
    emailAccountId,
    ENTRY_KEY,
    { savedAt: now, data: toStored(data) },
    now,
  );
}

function toStored({ stale: _stale, ...data }: TodayHomeData): GetHomeResponse {
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
  };
}

// "Today" counts and the next meeting belong to the day they were loaded;
// the fresh load fills them in again.
function withoutPastDay(data: GetHomeResponse, now: number): GetHomeResponse {
  return {
    ...data,
    today: { checked: 0, filed: 0, filedLabel: null },
    calendar: { ...data.calendar, next: null },
    nextUp: data.nextUp.filter(
      (item) => Date.parse(item.endAt ?? item.at) > now,
    ),
  };
}

function sameDay(a: number, b: number) {
  return new Date(a).toDateString() === new Date(b).toDateString();
}
