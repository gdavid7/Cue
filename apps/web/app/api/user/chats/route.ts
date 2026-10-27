import { NextResponse } from "next/server";
import prisma from "@/utils/prisma";
import { withAuth } from "@/utils/middleware";

export type GetUserChatsResponse = Awaited<ReturnType<typeof getUserChats>>;

// A chat covers all of the user's accounts and is held by the one it was
// started in; this lists every account's, so one history shows them all.
export const GET = withAuth("user/chats", async (request) => {
  const result = await getUserChats({ userId: request.auth.userId });
  return NextResponse.json(result);
});

async function getUserChats({ userId }: { userId: string }) {
  const chats = await prisma.chat.findMany({
    where: { emailAccount: { userId }, deletedAt: null },
    orderBy: { updatedAt: "desc" },
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      emailAccountId: true,
      emailAccount: {
        select: {
          email: true,
          account: { select: { disconnectedAt: true } },
        },
      },
    },
  });

  return {
    chats: chats.map(({ emailAccount, ...chat }) => ({
      ...chat,
      email: emailAccount.email,
      disconnected: Boolean(emailAccount.account.disconnectedAt),
    })),
  };
}
