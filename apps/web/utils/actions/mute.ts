"use server";

import { muteThreadsBody } from "@/utils/actions/mute.validation";
import { actionClient } from "@/utils/actions/safe-action";
import prisma from "@/utils/prisma";

// Only thread ids are stored (R-1), and nothing is written to the mailbox
// (D-008): new mail in these threads is archived as it arrives.
export const muteThreadsAction = actionClient
  .metadata({ name: "muteThreads", gmailPriority: "interactive" })
  .inputSchema(muteThreadsBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { threadIds } }) => {
    await prisma.mutedThread.createMany({
      data: [...new Set(threadIds)].map((threadId) => ({
        emailAccountId,
        threadId,
      })),
      skipDuplicates: true,
    });
    return { mutedThreadIds: threadIds };
  });

export const unmuteThreadsAction = actionClient
  .metadata({ name: "unmuteThreads", gmailPriority: "interactive" })
  .inputSchema(muteThreadsBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { threadIds } }) => {
    await prisma.mutedThread.deleteMany({
      where: { emailAccountId, threadId: { in: threadIds } },
    });
    return { unmutedThreadIds: threadIds };
  });
