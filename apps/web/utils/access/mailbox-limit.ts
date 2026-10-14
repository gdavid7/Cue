import { NextResponse } from "next/server";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import {
  MAILBOX_LIMIT_MESSAGE,
  MAX_EXTRA_MAILBOXES_PER_USER,
} from "@/utils/access/config";

/**
 * While the waitlist is on, one approval covers its owner's own mailboxes,
 * not a friend's. Callers skip this for reconnecting an existing mailbox.
 */
export async function isOverMailboxLimit({
  userId,
  maxExtraMailboxes = MAX_EXTRA_MAILBOXES_PER_USER,
  waitlistEnabled = env.AUTH_WAITLIST_ENABLED,
}: {
  userId: string;
  maxExtraMailboxes?: number | null;
  waitlistEnabled?: boolean;
}) {
  if (!waitlistEnabled || maxExtraMailboxes === null) return false;

  const mailboxCount = await prisma.emailAccount.count({ where: { userId } });
  return mailboxCount >= 1 + maxExtraMailboxes;
}

/**
 * Checked when the link starts, for a quick answer. The linking callbacks
 * check again before adding the mailbox, since parallel starts all pass here.
 */
export async function getMailboxLimitResponse({
  userId,
  isReconnect,
  maxExtraMailboxes,
  waitlistEnabled,
}: {
  userId: string;
  isReconnect: boolean;
  maxExtraMailboxes?: number | null;
  waitlistEnabled?: boolean;
}) {
  if (isReconnect) return null;
  if (
    !(await isOverMailboxLimit({ userId, maxExtraMailboxes, waitlistEnabled }))
  )
    return null;

  return NextResponse.json(
    { error: MAILBOX_LIMIT_MESSAGE, isKnownError: true },
    { status: 403 },
  );
}
