import { ensureAllMailSplit } from "@/utils/split-inbox/initial-splits";
import prisma from "@/utils/prisma";
import {
  isReplyTrackingOn,
  REPLY_TRACKING_RULES,
} from "@/utils/reply-tracker/reply-tracking-status";

export async function getMailSettings({
  emailAccountId,
}: {
  emailAccountId: string;
}) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      mailLayout: true,
      mailExpandedPreview: true,
      mailSplits: {
        // createdAt breaks ties so tab order can't shuffle between requests
        orderBy: [{ order: "asc" }, { createdAt: "asc" }],
        select: {
          id: true,
          name: true,
          order: true,
          matchAll: true,
          filters: {
            orderBy: { order: "asc" },
            select: { kind: true, value: true },
          },
        },
      },
      rules: REPLY_TRACKING_RULES,
    },
  });

  return {
    layout: emailAccount?.mailLayout ?? null,
    expandedPreview: emailAccount?.mailExpandedPreview ?? false,
    splits: ensureAllMailSplit(emailAccount?.mailSplits ?? []),
    replyTracking: isReplyTrackingOn(emailAccount?.rules),
  };
}
