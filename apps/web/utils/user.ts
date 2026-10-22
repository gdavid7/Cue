"use client";

import { toastDismiss, toastLoading } from "@/components/Toast";
import { signOut } from "@/utils/auth-client";
import { clearLastEmailAccountAction } from "@/utils/actions/email-account-cookie";
import { resetSigningOut, startSigningOut } from "@/utils/signing-out";
import { redirectToSafeUrl } from "@/utils/redirect";
import { wipeLocalMailbox } from "@/utils/mail-engine/wipe-local-mailbox";
import { clearLocalReplyDrafts } from "@/utils/mail-engine/reply-drafts";
import { clearPersistedSwrCache } from "@/utils/swr-persistence";
import { clearBrowserCaches } from "@/utils/browser-cache";
import { clearInboxInsightRequests } from "@/hooks/useInboxInsights";
import {
  isWebPushAvailable,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";

// Enough for a normal wipe (and the last-account cookie clear) to finish
// before leaving. A slower one stays marked and the next mail engine finishes
// it before opening.
const LOCAL_WIPE_WAIT_MS = 1500;

// Long enough for the browser to start unloading after a redirect.
const LEAVE_CANCELLED_AFTER_MS = 10_000;

let signingOut: Promise<void> | undefined;

/** Calls made while a sign-out is under way join it instead of starting over. */
export function logOut(callbackUrl = "/login") {
  signingOut ??= signOutAndLeave(callbackUrl);
  return signingOut;
}

async function signOutAndLeave(callbackUrl: string) {
  let toastId: string | number | undefined;
  try {
    toastId = toastLoading("Signing out…");
    startSigningOut();
    clearPersistedSwrCache();
    clearBrowserCaches();
    clearInboxInsightRequests();
    clearLocalReplyDrafts();
    const localWipe = wipeLocalMailbox();
    // The next person on this browser must not get this account's mail alerts.
    const pushStopped = isWebPushAvailable()
      ? syncWebPushSubscription("off").catch(() => false)
      : null;
    // Needs no session, so it may finish after sign-out; awaited below so
    // leaving the page does not cancel it.
    const lastAccountCleared = clearLastEmailAccountAction().catch(
      () => undefined,
    );
    // Leaving before the session cookie is cleared would land back in the app.
    await signOut().catch(() => undefined);
    await Promise.race([
      Promise.all([localWipe, lastAccountCleared, pushStopped]),
      delay(LOCAL_WIPE_WAIT_MS),
    ]);
  } finally {
    // A failed cleanup step must not strand a page that has stopped talking
    // to the server.
    resumeIfLeaveIsCancelled(toastId);
    redirectToSafeUrl(callbackUrl);
  }
}

// A "Leave site?" prompt that is cancelled fires no event, so a page that is
// still here this long after leaving was asked to go has stayed.
function resumeIfLeaveIsCancelled(toastId: string | number | undefined) {
  if (typeof window === "undefined") return;
  let left = false;
  window.addEventListener("pagehide", () => (left = true), { once: true });
  setTimeout(() => {
    if (left) return;
    if (toastId !== undefined) toastDismiss(toastId);
    signingOut = undefined;
    resetSigningOut();
  }, LEAVE_CANCELLED_AFTER_MS);
}

function delay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
