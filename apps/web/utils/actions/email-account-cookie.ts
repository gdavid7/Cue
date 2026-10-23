"use server";

import { clearLastEmailAccountCookie } from "@/utils/cookies.server";
import { publicActionClient } from "@/utils/actions/safe-action";

/**
 * Clears the last email account cookie.
 * Called on logout to prevent stale account IDs when switching users.
 * Needs no session: it only deletes the caller's own cookie, and sign-out may
 * already have ended the session (or it expired) by the time it runs. It
 * reads nothing and calls nothing, so there is nothing to rate-limit.
 */
export const clearLastEmailAccountAction = publicActionClient
  .metadata({ name: "clearLastEmailAccount" })
  .action(async () => {
    await clearLastEmailAccountCookie();
  });
