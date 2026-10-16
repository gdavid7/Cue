import { NextResponse } from "next/server";
import {
  cleanInboxQueueBody,
  queueCleanInboxThreads,
} from "@/app/api/clean/queue-inbox";
import { isCleanerApiEnabled } from "@/utils/cleaner-feature";
import { createEmailProvider } from "@/utils/email/provider";
import { withError } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { withQstashOrInternal } from "@/utils/qstash";

export const maxDuration = 300;

// Delivered once the Gmail quota gate's deferral of a clean job has passed,
// so the job keeps queueing the inbox from the page it stopped at.
export const POST = withError(
  "clean/resume",
  withQstashOrInternal(async (request) => {
    // A delivery QStash sees fail is retried, and turning the cleaner off is
    // not something a retry fixes.
    if (!isCleanerApiEnabled()) {
      request.logger.info("Cleaner is not enabled; not resuming clean job");
      return NextResponse.json({ ok: true });
    }

    const parsed = cleanInboxQueueBody.safeParse(await request.json());
    if (!parsed.success) {
      return new Response("Invalid payload structure", { status: 400 });
    }
    const job = parsed.data;
    const logger = request.logger.with({
      emailAccountId: job.emailAccountId,
      jobId: job.jobId,
    });

    const exists = await prisma.cleanupJob.findFirst({
      where: { id: job.jobId, emailAccountId: job.emailAccountId },
      select: { id: true },
    });
    if (!exists) {
      logger.info("Clean job no longer exists; not resuming");
      return NextResponse.json({ ok: true });
    }

    // Clean inbox only runs for Google accounts.
    const emailProvider = await createEmailProvider({
      emailAccountId: job.emailAccountId,
      provider: "google",
      logger,
    });
    await queueCleanInboxThreads({ ...job, emailProvider, logger });
    return NextResponse.json({ ok: true });
  }),
);
