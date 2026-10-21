import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { Prisma } from "@/generated/prisma/client";
import type { ScheduledEmailStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/prisma";
import { scheduleEmailBody } from "@/utils/actions/scheduled-email.validation";
import {
  processScheduledEmail,
  scheduleEmail,
} from "@/utils/scheduled-email/service";

const UPCOMING_STATUSES: ScheduledEmailStatus[] = [
  "PENDING",
  "PROCESSING",
  "BLOCKED_AUTH",
  "FAILED",
  "UNCERTAIN",
];

const SENT_DRAFTS_HIDDEN_MS = 24 * 60 * 60 * 1000;

type UpcomingScheduledEmail = {
  id: string;
  status: ScheduledEmailStatus;
  sendAt: Date;
  threadId: string | null;
  error: string | null;
  to: string | null;
  subject: string | null;
  draftMessageIds: string[];
};

export type ScheduledEmailsResponse = Awaited<ReturnType<typeof getThreadData>>;
export type UpcomingScheduledEmailsResponse = Awaited<
  ReturnType<typeof getUpcomingData>
>;

export type ScheduleEmailResponse = { id: string };

export const GET = withEmailAccount(async (request) => {
  const threadId = request.nextUrl.searchParams.get("threadId");
  const { emailAccountId } = request.auth;
  return NextResponse.json(
    threadId
      ? await getThreadData(emailAccountId, threadId)
      : await getUpcomingData(emailAccountId),
  );
});

/**
 * REST equivalent of `scheduleEmailAction`. A null `sendAt` sends now,
 * matching the action, so clients share that send path.
 */
export const POST = withEmailAccount(
  "user/scheduled-emails",
  async (request) => {
    const body = scheduleEmailBody.parse(await request.json());
    const row = await scheduleEmail(request.auth.emailAccountId, body);
    if (!body.sendAt) await processScheduledEmail(row.id, request.logger);
    return NextResponse.json({ id: row.id } satisfies ScheduleEmailResponse);
  },
);

async function getThreadData(emailAccountId: string, threadId: string) {
  const scheduledEmails = await prisma.scheduledEmail.findMany({
    where: {
      emailAccountId,
      threadId,
      status: { not: "CANCELLED" },
      AND: [
        // An undo hold shows once it has sent, for the reminder it carries.
        {
          OR: [
            { heldForUndo: false },
            { status: "SENT", remindAt: { not: null } },
          ],
        },
        {
          OR: [
            { status: { not: "SENT" } },
            { reminderStatus: { in: ["PENDING", "PROCESSING"] } },
            { sentAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
          ],
        },
      ],
    },
    select: {
      id: true,
      status: true,
      sendAt: true,
      remindAt: true,
      reminderStatus: true,
      sentAt: true,
      error: true,
      draftMessageIds: true,
    },
    orderBy: { createdAt: "desc" },
  });
  return { scheduledEmails };
}

/**
 * Reads recipient and subject out of the payload JSON instead of selecting it:
 * a scheduled send carries its body, and older ones their attachments, which
 * run to megabytes.
 */
async function getUpcomingData(emailAccountId: string) {
  const scheduledEmails = await prisma.$queryRaw<UpcomingScheduledEmail[]>`
    SELECT
      "id",
      "status",
      "sendAt",
      "threadId",
      "error",
      "payload" -> 'email' ->> 'to' AS "to",
      "payload" -> 'email' ->> 'subject' AS "subject",
      "draftMessageIds"
    FROM "ScheduledEmail"
    WHERE "emailAccountId" = ${emailAccountId}
      AND NOT "heldForUndo"
      AND "status"::text IN (${Prisma.join(UPCOMING_STATUSES)})
    ORDER BY "sendAt" ASC
    LIMIT 200
  `;
  // A sent draft stays in the mailbox here until sync reports it gone, so the
  // client keeps it out of Drafts for a while after. An undo hold is sent by
  // the device's engine, which drops its drafts itself once it goes out.
  const sent = await prisma.scheduledEmail.findMany({
    where: {
      emailAccountId,
      heldForUndo: false,
      status: "SENT",
      sentAt: { gte: new Date(Date.now() - SENT_DRAFTS_HIDDEN_MS) },
    },
    select: { draftMessageIds: true },
    orderBy: { sentAt: "desc" },
    take: 200,
  });
  return {
    scheduledEmails,
    sentDraftMessageIds: [
      ...new Set(sent.flatMap((row) => row.draftMessageIds)),
    ],
  };
}
