"use server";

import { dismissAwaySummaryBody } from "@/utils/actions/away-summary.validation";
import { actionClientUser } from "@/utils/actions/safe-action";
import { dismissAwaySummary } from "@/utils/home/away-summary";
import { recordLastLogin } from "@/utils/user/last-login";

/**
 * Hides Today's "While you were away" for the person until their next return
 * after a break. Clears only the visit the card showed (compare-and-clear), so
 * a stale tab can't wipe a newer return's card.
 */
export const dismissAwaySummaryAction = actionClientUser
  .metadata({ name: "dismissAwaySummary" })
  .inputSchema(dismissAwaySummaryBody)
  .action(async ({ ctx: { userId }, parsedInput: { lastVisitAt } }) => {
    const dismissed = await dismissAwaySummary({ userId, lastVisitAt });
    return { dismissed };
  });

/** The browser saw the user using the app; see VisitRecorder. */
export const recordVisitAction = actionClientUser
  .metadata({ name: "recordVisit" })
  .action(async ({ ctx: { userId } }) => {
    await recordLastLogin(userId);
    return { success: true };
  });
