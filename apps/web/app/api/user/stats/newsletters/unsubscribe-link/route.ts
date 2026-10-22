import { NextResponse } from "next/server";
import { z } from "zod";
import prisma from "@/utils/prisma";
import { withEmailAccount } from "@/utils/middleware";

const query = z.object({ sender: z.string().trim().min(3).max(320) });

export type SenderUnsubscribeLinkResponse = Awaited<
  ReturnType<typeof getSenderUnsubscribeLink>
>;

/**
 * One sender's unsubscribe link from the mail stats Bulk unsubscribe keeps,
 * newest first. Only that read: no sender stats, statuses or provider
 * filters, so asking for one link stays quick.
 */
async function getSenderUnsubscribeLink({
  emailAccountId,
  sender,
}: {
  emailAccountId: string;
  sender: string;
}) {
  const message = await prisma.emailMessage.findFirst({
    where: {
      emailAccountId,
      from: { equals: sender, mode: "insensitive" },
      sent: false,
      draft: false,
      unsubscribeLink: { not: null },
    },
    orderBy: { date: "desc" },
    select: { unsubscribeLink: true },
  });
  return { unsubscribeLink: message?.unsubscribeLink ?? null };
}

export const GET = withEmailAccount(
  "user/stats/newsletters/unsubscribe-link",
  async (request) => {
    const { sender } = query.parse({
      sender: new URL(request.url).searchParams.get("sender"),
    });
    return NextResponse.json(
      await getSenderUnsubscribeLink({
        emailAccountId: request.auth.emailAccountId,
        sender,
      }),
    );
  },
);
