import type { ListThread } from "@/app/(app)/[emailAccountId]/mail/types";

/**
 * The top of the inbox as it was last shown, kept in this browser so the next
 * visit paints it while the mail engine opens the local mailbox, which takes
 * seconds on a phone. It holds what those rows show (senders, subjects and a
 * line of preview), as the local mailbox already does on this device. It is
 * kept per account and cleared on sign-out and when the account is removed.
 */

const PREFIX = "cue:inbox-snapshot:v1:";
// About two screens of rows on a large display.
export const INBOX_SNAPSHOT_ROWS = 30;
// A row shows one line of preview; the rest would only take up storage.
const PREVIEW_LENGTH = 200;

type Entry = { emailAccountId: string; savedAt: number; threads: ListThread[] };

// Set on sign-out, so a page hiding on the way out can't save the inbox again.
// Module state ends with the page, which is the life the block needs.
let blocked = false;
const blockedAccountIds = new Set<string>();

export function readInboxSnapshot(emailAccountId: string): ListThread[] | null {
  if (!emailAccountId) return null;
  try {
    const raw = window.localStorage.getItem(storageKey(emailAccountId));
    if (!raw) return null;
    const entry = JSON.parse(raw) as Partial<Entry>;
    if (
      entry.emailAccountId !== emailAccountId ||
      !Array.isArray(entry.threads) ||
      !entry.threads.length
    )
      return null;
    return entry.threads;
  } catch {
    return null;
  }
}

export function writeInboxSnapshot(
  emailAccountId: string,
  threads: readonly ListThread[],
  now = Date.now(),
) {
  if (!emailAccountId || !threads.length) return;
  if (blocked || blockedAccountIds.has(emailAccountId)) return;
  const entry: Entry = {
    emailAccountId,
    savedAt: now,
    threads: threads.slice(0, INBOX_SNAPSHOT_ROWS).map(toStored),
  };
  try {
    window.localStorage.setItem(
      storageKey(emailAccountId),
      JSON.stringify(entry),
    );
  } catch {
    // Full or blocked storage only costs the instant first paint.
  }
}

export function clearInboxSnapshots() {
  blocked = true;
  try {
    for (const key of snapshotKeys()) window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures on the way out.
  }
}

export function clearInboxSnapshot(emailAccountId: string) {
  blockedAccountIds.add(emailAccountId);
  try {
    window.localStorage.removeItem(storageKey(emailAccountId));
  } catch {
    // Ignore storage failures.
  }
}

export function resetInboxSnapshotBlocksForTesting() {
  blocked = false;
  blockedAccountIds.clear();
}

function toStored(thread: ListThread): ListThread {
  return {
    ...thread,
    snippet: shorten(thread.snippet),
    messages: thread.messages.map((message) => ({
      ...message,
      snippet: shorten(message.snippet),
    })),
  };
}

function shorten(text: string | undefined) {
  return text && text.length > PREVIEW_LENGTH
    ? text.slice(0, PREVIEW_LENGTH)
    : (text ?? "");
}

function storageKey(emailAccountId: string) {
  return `${PREFIX}${emailAccountId}`;
}

function snapshotKeys() {
  const keys: string[] = [];
  for (let index = 0; index < window.localStorage.length; index++) {
    const key = window.localStorage.key(index);
    if (key?.startsWith(PREFIX)) keys.push(key);
  }
  return keys;
}
