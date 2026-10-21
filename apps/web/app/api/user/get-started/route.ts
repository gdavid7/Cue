import { NextResponse } from "next/server";
import { withAuth } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import {
  getGetStartedItems,
  getGetStartedStatus,
  isGetStartedWindowOpen,
} from "@/utils/get-started/checklist";
import { getGetStartedFacts } from "@/utils/get-started/checklist.server";

export type GetStartedResponse = Awaited<ReturnType<typeof getGetStarted>>;

export const GET = withAuth("user/get-started", async (request) => {
  const result = await getGetStarted({ userId: request.auth.userId });
  // Steps tick off as they happen; a cached answer would show them undone.
  return NextResponse.json(result, {
    headers: { "Cache-Control": "no-store" },
  });
});

async function getGetStarted({ userId }: { userId: string }) {
  const now = new Date();
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      createdAt: true,
      dismissedHints: true,
      emailAccounts: { select: { id: true } },
    },
  });
  // Past the first week, or closed, nothing more is read.
  if (!isGetStartedWindowOpen(user, now)) return { items: null };

  const emailAccountIds = user.emailAccounts.map((account) => account.id);
  const items = getGetStartedItems({
    dismissedHints: user.dismissedHints,
    emailAccountIds,
    facts: await getGetStartedFacts(emailAccountIds),
  });
  if (getGetStartedStatus({ user, items, now }) !== "active")
    return { items: null };
  return { items };
}
