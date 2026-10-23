import { NextResponse } from "next/server";
import { hasCueReadMail } from "@/utils/home/get-home";
import { withEmailAccount } from "@/utils/middleware";

export type GetHomeCueResponse = Awaited<ReturnType<typeof getHomeCue>>;

// Today's own answer waits on Gmail for seconds; this is two database reads,
// so a new mailbox can show what's waiting on the user from local mail first.
export const GET = withEmailAccount("user/home/cue", async (request) => {
  const cue = await getHomeCue(request.auth.emailAccountId);
  return NextResponse.json(cue, {
    headers: { "Cache-Control": "private, no-store" },
  });
});

async function getHomeCue(emailAccountId: string) {
  return { hasReadMail: await hasCueReadMail(emailAccountId) };
}
