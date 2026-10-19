import { NextResponse } from "next/server";
import { createEmailProvider } from "@/utils/email/provider";
import {
  MAIL_BULK_JOB_CALLER,
  mailBulkJobBody,
  runMailBulkJobStep,
} from "@/utils/mail-bulk/run-matching-job";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

// One delivery of a bulk action over every conversation a view matches. The
// job hands what it has left to the next delivery before this one times out.
export const POST = withError(
  MAIL_BULK_JOB_CALLER,
  withQstashOrInternal(async (request) => {
    const parsed = mailBulkJobBody.safeParse(await request.json());
    if (!parsed.success) {
      return new Response("Invalid payload structure", { status: 400 });
    }
    const body = parsed.data;
    const logger = request.logger.with({
      emailAccountId: body.emailAccountId,
      jobId: body.jobId,
    });

    const emailAccount = await prisma.emailAccount.findUnique({
      where: { id: body.emailAccountId },
      select: { email: true, account: { select: { provider: true } } },
    });
    // A delivery QStash sees fail is retried, and a removed account stays
    // removed.
    if (!emailAccount) {
      logger.info("Email account no longer exists; not running bulk action");
      return NextResponse.json({ ok: true });
    }

    const provider = await createEmailProvider({
      emailAccountId: body.emailAccountId,
      provider: emailAccount.account.provider,
      logger,
    });
    const result = await runMailBulkJobStep({
      body,
      provider,
      ownerEmail: emailAccount.email,
      logger,
    });
    return NextResponse.json({ result });
  }),
);
