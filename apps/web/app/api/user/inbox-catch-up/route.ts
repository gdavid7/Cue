import { NextResponse } from "next/server";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { withEmailAccount } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { loadInboxPreview } from "@/utils/threads/inbox-preview.server";

export type GetInboxCatchUpResponse = Awaited<
  ReturnType<typeof getInboxCatchUp>
>;

/**
 * The inbox's newest messages for a local mailbox that fell behind while its
 * tab was away, the same read a page load makes for one (RL-1), for the mail
 * engine to add ahead of its catch-up, which replays Gmail's history oldest
 * first. Someone is looking at the inbox, so it runs at interactive priority.
 */
export const GET = withEmailAccount("user/inbox-catch-up", async (request) => {
  const result = await getInboxCatchUp(request.auth.emailAccountId);
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
});

async function getInboxCatchUp(emailAccountId: string) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: { account: { select: { provider: true } } },
  });
  const provider = emailAccount?.account?.provider;
  // Outlook's engine reads its mail by folder, so the preview hands it
  // nothing and the read would only spend quota.
  if (!isGoogleProvider(provider)) return { changes: [] };
  const preview = await loadInboxPreview({
    emailAccountId,
    provider,
    catchUp: true,
  });
  return { changes: preview?.changes ?? [] };
}
