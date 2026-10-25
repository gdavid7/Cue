import { isSigningOut } from "@/utils/signing-out";
import {
  clearSessionExpired,
  notifySessionExpired,
} from "@/utils/session-expired";
import { redirectToSafeUrl } from "@/utils/redirect";

/**
 * A page restored from the back/forward cache keeps its old memory and
 * screen, so after a sign-out Back would show the previous user's mail.
 * Sends it to log in when it was left mid sign-out, and otherwise checks that
 * its session is still there.
 */
export function guardRestoredPage() {
  const onPageShow = (event: PageTransitionEvent) => {
    if (!event.persisted) return;
    if (isSigningOut()) {
      redirectToSafeUrl("/login");
      return;
    }
    // A redirect that left this page is over; whether to send it to log in
    // again rests on the session it has now.
    clearSessionExpired();
    fetch("/api/auth/get-session", { credentials: "include" })
      .then((response) => response.json())
      .then((session: unknown) => {
        if (session === null) notifySessionExpired();
      })
      .catch(() => undefined);
  };
  window.addEventListener("pageshow", onPageShow);
  return () => window.removeEventListener("pageshow", onPageShow);
}
