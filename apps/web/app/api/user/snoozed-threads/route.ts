import { NextResponse } from "next/server";
import { z } from "zod";
import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import { snoozeThreadsBody } from "@/utils/actions/snooze.validation";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import { snoozeThreads } from "@/utils/snooze/snooze";
import { unsnoozeThreads } from "@/utils/snooze/unsnooze";

const ACTIVE_SNOOZE_STATUSES = [
  SnoozedThreadStatus.PREPARING,
  SnoozedThreadStatus.PENDING,
  SnoozedThreadStatus.EXECUTING,
];

const unsnoozeThreadsBody = z.object({
  threadIds: z.array(z.string().min(1).max(512)).min(1).max(100),
});

export type SnoozedThreadsResponse = Awaited<
  ReturnType<typeof listSnoozedThreads>
>;
export type SnoozeThreadsResponse = Awaited<ReturnType<typeof snoozeThreads>>;
export type UnsnoozeThreadsResponse = Awaited<
  ReturnType<typeof unsnoozeThreads>
>;

export const GET = withEmailProvider("user/snoozed-threads", async (request) =>
  NextResponse.json(
    await listSnoozedThreads({
      emailAccountId: request.auth.emailAccountId,
      provider: request.emailProvider,
      logger: request.logger,
    }),
  ),
);

export const POST = withEmailProvider(
  "user/snoozed-threads/create",
  async (request) => {
    const body = snoozeThreadsBody.parse(await request.json());
    const result = await snoozeThreads({
      emailAccountId: request.auth.emailAccountId,
      logger: request.logger,
      ownerEmail: request.auth.email,
      provider: request.emailProvider,
      snoozedUntil: body.snoozedUntil,
      threadIds: body.threadIds,
    });
    return NextResponse.json(result satisfies SnoozeThreadsResponse);
  },
);

export const DELETE = withEmailProvider(
  "user/snoozed-threads/delete",
  async (request) => {
    const body = unsnoozeThreadsBody.parse(await request.json());
    const result = await unsnoozeThreads({
      emailAccountId: request.auth.emailAccountId,
      logger: request.logger,
      provider: request.emailProvider,
      threadIds: body.threadIds,
    });
    return NextResponse.json(result satisfies UnsnoozeThreadsResponse);
  },
);

async function listSnoozedThreads({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  logger: Logger;
}) {
  const rows = await prisma.snoozedThread.findMany({
    where: {
      emailAccountId,
      status: { in: ACTIVE_SNOOZE_STATUSES },
    },
    orderBy: { scheduledFor: "asc" },
    take: MAX_LISTED_SNOOZES,
    select: {
      id: true,
      threadId: true,
      scheduledFor: true,
      status: true,
    },
  });

  // The rows only know thread ids; the provider supplies what each one is.
  const summaries = new Map<string, ThreadSummary>();
  for (let start = 0; start < rows.length; start += SUMMARY_CONCURRENCY) {
    const chunk = rows.slice(start, start + SUMMARY_CONCURRENCY);
    const results = await Promise.allSettled(
      chunk.map((row) => provider.getLatestMessageInThread(row.threadId)),
    );
    results.forEach((result, index) => {
      const threadId = chunk[index].threadId;
      if (result.status === "rejected") {
        logger.warn("Failed to load snoozed thread", {
          threadId,
          error: result.reason,
        });
        return;
      }
      if (!result.value) return;
      summaries.set(threadId, {
        subject: result.value.headers.subject || result.value.subject || "",
        from: result.value.headers.from || "",
        snippet: result.value.snippet || "",
      });
    });
  }

  return {
    threads: rows.map((row) => ({
      id: row.id,
      threadId: row.threadId,
      scheduledFor: row.scheduledFor.toISOString(),
      status: row.status,
      ...(summaries.get(row.threadId) ?? EMPTY_SUMMARY),
    })),
  };
}

type ThreadSummary = { subject: string; from: string; snippet: string };

const MAX_LISTED_SNOOZES = 100;
const SUMMARY_CONCURRENCY = 5;
const EMPTY_SUMMARY: ThreadSummary = { subject: "", from: "", snippet: "" };
