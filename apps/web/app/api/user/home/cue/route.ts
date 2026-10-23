import { NextResponse } from "next/server";
import { z } from "zod";
import { hasCueReadMail } from "@/utils/home/get-home";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";

// More than All inboxes holds for anyone; it bounds the reads one request asks.
const MAX_ACCOUNTS = 20;

const querySchema = z.object({
  ids: z
    .string()
    .transform((ids) => [...new Set(ids.split(",").filter(Boolean))])
    .pipe(z.array(z.string()).min(1).max(MAX_ACCOUNTS)),
});

export type GetHomeCueResponse = Awaited<ReturnType<typeof getHomeCue>>;

// Whether Cue has read each mailbox Today shows. Today's own answer says so
// too, but waits on Gmail for seconds; this is two database reads a mailbox,
// so a new one can show what's waiting on the user from local mail first.
export const GET = withAuth("user/home/cue", async (request) => {
  const query = querySchema.safeParse({
    ids: new URL(request.url).searchParams.get("ids") ?? "",
  });
  if (!query.success)
    return NextResponse.json({ error: "Invalid account ids" }, { status: 400 });
  const result = await getHomeCue(request.auth.userId, query.data.ids);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

/** Only the user's own accounts answer; any other id is left out. */
async function getHomeCue(userId: string, ids: string[]) {
  const accounts = await prisma.emailAccount.findMany({
    where: { id: { in: ids }, userId },
    select: { id: true },
  });
  return {
    accounts: await Promise.all(
      accounts.map(async ({ id }) => ({
        id,
        hasReadMail: await hasCueReadMail(id),
      })),
    ),
  };
}
