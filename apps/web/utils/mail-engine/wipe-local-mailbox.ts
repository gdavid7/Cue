import { clearRecentSearchHistory } from "@/store/mail-search-history";
import { clearStoredSenderQueues } from "@/store/sender-queue";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { closeActiveMailEngine } from "@/utils/mail-engine/active-client";
import { clearLocalMailboxCookie } from "@/utils/mail-engine/local-mailbox-cookie";
import { wipeOpfsMailEngine } from "@/utils/mail-engine/opfs-mailbox";
import { deleteMailRecoveryStash } from "@/utils/mail-engine/recovery-stash";
import { clearOfflineMailCache } from "@/utils/offline/clear-mail-cache";

// Sign-out leaves the page before a slow wipe can finish, so the marker
// outlives the page and the next mail engine finishes the wipe before opening.
const WIPE_PENDING_KEY = "inbox-zero:local-mailbox-wipe-pending";

export async function wipeLocalMailbox() {
  setWipePending(true);
  // The next sign-in then shows the inbox from the server while it syncs.
  clearLocalMailboxCookie();
  clearStoredSenderQueues();
  clearRecentSearchHistory();
  // The open engine holds the mailbox files until it is closed.
  await removeLocalMail(closeActiveMailEngine());
}

export async function finishPendingLocalMailboxWipe() {
  if (isWipePending()) await removeLocalMail(Promise.resolve());
}

async function removeLocalMail(engineClosed: Promise<void>) {
  const [mailboxWiped, , stashDeleted] = await Promise.all([
    engineClosed.then(wipeMailboxStore),
    clearOfflineMailCache(),
    deleteMailRecoveryStash(),
  ]);
  // The stash holds the signed-out user's drafts and commands as much as the
  // mailbox does.
  if (mailboxWiped && stashDeleted) setWipePending(false);
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
