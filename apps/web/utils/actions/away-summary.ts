"use server";

import { actionClientUser } from "@/utils/actions/safe-action";
import prisma from "@/utils/prisma";

/**
 * Hides Today's "While you were away" until the user's next return after a
 * break, on every device: the next visit sets a new last visit.
 */
export const dismissAwaySummaryAction = actionClientUser
  .metadata({ name: "dismissAwaySummary" })
  .action(async ({ ctx: { userId } }) => {
    await prisma.user.update({
      where: { id: userId },
      data: { previousVisitAt: null },
    });
    return { success: true };
  });
