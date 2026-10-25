import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type MutedThreadIdsResponse = Awaited<
  ReturnType<typeof getMutedThreadIds>
>;

/**
 * Just the ids, from our database alone, for the open tab's new-mail
 * notifications to leave muted conversations out before the server's
 * archive of their new mail reaches the browser.
 */
export const GET = withEmailAccount("user/muted-threads/ids", async (request) =>
  NextResponse.json(await getMutedThreadIds(request.auth.emailAccountId), {
    headers: { "Cache-Control": "no-store" },
  }),
);

async function getMutedThreadIds(emailAccountId: string) {
  const rows = await prisma.mutedThread.findMany({
    where: { emailAccountId },
    orderBy: { createdAt: "desc" },
    select: { threadId: true },
    take: MAX_MUTED_IDS,
  });
  return { threadIds: rows.map((row) => row.threadId) };
}

const MAX_MUTED_IDS = 5000;
