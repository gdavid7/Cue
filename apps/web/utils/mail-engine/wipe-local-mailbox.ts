import { clearRecentSearchHistory } from "@/store/mail-search-history";
import { clearStoredSenderQueues } from "@/store/sender-queue";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { closeActiveMailEngine } from "@/utils/mail-engine/active-client";
import { wipeOpfsMailEngine } from "@/utils/mail-engine/opfs-mailbox";
import { clearOfflineMailCache } from "@/utils/offline/clear-mail-cache";

// Sign-out leaves the page before a slow wipe can finish, so the marker
// outlives the page and the next mail engine finishes the wipe before opening.
const WIPE_PENDING_KEY = "inbox-zero:local-mailbox-wipe-pending";

export async function wipeLocalMailbox() {
  setWipePending(true);
  clearStoredSenderQueues();
  clearRecentSearchHistory();
  // The open engine holds the mailbox files until it is closed.
  await removeLocalMail(closeActiveMailEngine());
}

export async function finishPendingLocalMailboxWipe() {
  if (isWipePending()) await removeLocalMail(Promise.resolve());
}

async function removeLocalMail(engineClosed: Promise<void>) {
  const [mailboxWiped] = await Promise.all([
    engineClosed.then(wipeMailboxStore),
    clearOfflineMailCache(),
  ]);
  if (mailboxWiped) setWipePending(false);
}

async function wipeMailboxStore() {
  const wipe = getInboxZeroDesktopApp()?.wipeMailbox;
  if (typeof wipe === "function") {
    try {
      await wipe();
      return true;
    } catch {
      return false;
    }
  }
  return wipeOpfsMailEngine();
}

function isWipePending() {
  try {
    return window.localStorage.getItem(WIPE_PENDING_KEY) === "1";
  } catch {
    return false;
  }
}

function setWipePending(pending: boolean) {
  try {
    if (pending) window.localStorage.setItem(WIPE_PENDING_KEY, "1");
    else window.localStorage.removeItem(WIPE_PENDING_KEY);
  } catch {
    // Storage can be unavailable in private browsing; the wipe still runs.
  }
}
