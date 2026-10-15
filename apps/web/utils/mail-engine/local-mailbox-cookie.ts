/**
 * Which accounts this browser holds a synced local mailbox for, so the server
 * knows when a first visit needs the inbox from the provider instead. It only
 * carries account ids the signed-in user owns; the server still resolves the
 * account from the session.
 */
export const LOCAL_MAILBOX_COOKIE = "cue-local-mail";

const MAX_AGE_SECONDS = 60 * 60 * 24 * 365;

export function hasLocalMailbox(
  cookieValue: string | undefined,
  accountId: string,
) {
  return readAccountIds(cookieValue).includes(accountId);
}

export function markLocalMailboxSynced(accountId: string) {
  const accountIds = readAccountIds(readCookie());
  if (accountIds.includes(accountId)) return;
  writeCookie([...accountIds, accountId].join("."), MAX_AGE_SECONDS);
}

/** Part of wiping the local mailbox, on sign-out. */
export function clearLocalMailboxCookie() {
  writeCookie("", 0);
}

function readAccountIds(cookieValue: string | undefined) {
  return cookieValue ? decodeURIComponent(cookieValue).split(".") : [];
}

function readCookie() {
  if (typeof document === "undefined") return;
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${LOCAL_MAILBOX_COOKIE}=`))
    ?.slice(LOCAL_MAILBOX_COOKIE.length + 1);
}

function writeCookie(value: string, maxAgeSeconds: number) {
  if (typeof document === "undefined") return;
  document.cookie = `${LOCAL_MAILBOX_COOKIE}=${encodeURIComponent(value)}; path=/; max-age=${maxAgeSeconds}; SameSite=Lax${location.protocol === "https:" ? "; Secure" : ""}`;
}
