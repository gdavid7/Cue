import { NextResponse } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import { MAX_EXTRA_MAILBOXES_PER_USER } from "@/utils/access/config";

export const MAILBOX_LIMIT_MESSAGE =
  "You've connected as many mailboxes as the beta allows. Cue access is personal, so each person needs their own approval.";

/**
 * While the waitlist is on, one approval covers its owner's own mailboxes,
 * not a friend's. Reconnecting an existing mailbox is never limited.
 */
export async function getMailboxLimitResponse({
  userId,
  isReconnect,
  maxExtraMailboxes = MAX_EXTRA_MAILBOXES_PER_USER,
  waitlistEnabled = env.AUTH_WAITLIST_ENABLED,
}: {
  userId: string;
  isReconnect: boolean;
  maxExtraMailboxes?: number | null;
  waitlistEnabled?: boolean;
}) {
  if (!waitlistEnabled || isReconnect || maxExtraMailboxes === null)
    return null;

  const mailboxCount = await prisma.emailAccount.count({ where: { userId } });
  if (mailboxCount < 1 + maxExtraMailboxes) return null;

  return NextResponse.json(
    { error: MAILBOX_LIMIT_MESSAGE, isKnownError: true },
    { status: 403 },
  );
}
