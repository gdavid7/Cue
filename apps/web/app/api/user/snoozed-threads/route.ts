import { NextResponse } from "next/server";
import { z } from "zod";
import { SnoozedThreadStatus } from "@/generated/prisma/enums";
import { snoozeThreadsBody } from "@/utils/actions/snooze.validation";
import { mapWithConcurrency } from "@/utils/async";
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
  const summaries = await mapWithConcurrency(
    rows,
    SUMMARY_CONCURRENCY,
    async (row) => {
      try {
        const message = await provider.getLatestMessageInThread(row.threadId);
        return {
          subject: message?.headers.subject || message?.subject || "",
          from: message?.headers.from || "",
          snippet: message?.snippet || "",
        };
      } catch (error) {
        logger.warn("Failed to load snoozed thread", {
          threadId: row.threadId,
          error,
        });
        return { subject: "", from: "", snippet: "" };
      }
    },
  );

  return {
    threads: rows.map((row, index) => ({
      id: row.id,
      threadId: row.threadId,
      scheduledFor: row.scheduledFor.toISOString(),
      status: row.status,
      ...summaries[index],
    })),
  };
}

const MAX_LISTED_SNOOZES = 100;
const SUMMARY_CONCURRENCY = 5;
