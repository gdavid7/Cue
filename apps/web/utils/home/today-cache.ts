import type { GetHomeResponse } from "@/app/api/user/home/route";

/**
 * Today's last answer, kept in this browser so Today opens on it at once
 * while a fresh one loads from Gmail, which can take seconds. It holds what
 * Today shows: senders, subjects and short previews, like the local mail
 * store already does on this device. It is kept per user and account, for a
 * day, and is cleared on sign-out and when the account is removed.
 */

/** "Also in your inbox" shows this many rows. */
export const ALSO_IN_INBOX_LIMIT = 5;

const PREFIX = "cue:today:v1:";
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
// A row shows one line of preview; the rest would only take up storage.
const PREVIEW_LENGTH = 140;

type Entry = {
  userId: string;
  emailAccountId: string;
  savedAt: number;
  data: GetHomeResponse;
};

type Owner = { userId: string; emailAccountId: string };

// Set on sign-out, so a load that lands on the way out can't save Today
// again. Module state ends with the page, which is the life the block needs.
let blocked = false;
const blockedAccountIds = new Set<string>();

export function readCachedToday({
  userId,
  emailAccountId,
  now = Date.now(),
}: Owner & { now?: number }): GetHomeResponse | undefined {
  if (!userId || !emailAccountId) return;
  const key = storageKey({ userId, emailAccountId });
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return;
    const entry = JSON.parse(raw) as Partial<Entry>;
    if (
      entry.userId !== userId ||
      entry.emailAccountId !== emailAccountId ||
      typeof entry.savedAt !== "number" ||
      !entry.data
    )
      return;
    if (now - entry.savedAt > MAX_AGE_MS) {
      window.localStorage.removeItem(key);
      return;
    }
    return entry.data;
  } catch {
    return;
  }
}

/** Saves Today when every lane loaded: a pending lane would read as empty. */
export function writeCachedToday({
  userId,
  emailAccountId,
  data,
  now = Date.now(),
}: Owner & { data: GetHomeResponse; now?: number }) {
  if (!userId || !emailAccountId) return;
  if (blocked || blockedAccountIds.has(emailAccountId)) return;
  if (data.pending.length || data.failed.length) return;
  try {
    // One user's Today at a time on a shared device.
    for (const key of todayKeys())
      if (!key.startsWith(`${PREFIX}${userId}:`))
        window.localStorage.removeItem(key);
    const entry: Entry = {
      userId,
      emailAccountId,
      savedAt: now,
      data: toStored(data),
    };
    window.localStorage.setItem(
      storageKey({ userId, emailAccountId }),
      JSON.stringify(entry),
    );
  } catch {
    // Full or blocked storage only costs the instant first paint.
  }
}

export function clearCachedToday() {
  blocked = true;
  try {
    for (const key of todayKeys()) window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures on the way out.
  }
}

export function clearCachedTodayForAccount(emailAccountId: string) {
  blockedAccountIds.add(emailAccountId);
  try {
    for (const key of todayKeys())
      if (key.endsWith(`:${emailAccountId}`))
        window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

export function resetCachedTodayBlocksForTesting() {
  blocked = false;
  blockedAccountIds.clear();
}

function toStored(data: GetHomeResponse): GetHomeResponse {
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

function storageKey({ userId, emailAccountId }: Owner) {
  return `${PREFIX}${userId}:${emailAccountId}`;
}

function todayKeys() {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}
