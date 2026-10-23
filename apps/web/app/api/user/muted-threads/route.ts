import { NextResponse } from "next/server";
import { mapWithConcurrency } from "@/utils/async";
import type { EmailProvider } from "@/utils/email/types";
import type { Logger } from "@/utils/logger";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";

export type MutedThreadsResponse = Awaited<ReturnType<typeof listMutedThreads>>;

export const GET = withEmailProvider("user/muted-threads", async (request) =>
  NextResponse.json(
    await listMutedThreads({
      emailAccountId: request.auth.emailAccountId,
      provider: request.emailProvider,
      logger: request.logger,
    }),
  ),
);

async function listMutedThreads({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: EmailProvider;
  logger: Logger;
}) {
  const rows = await prisma.mutedThread.findMany({
    where: { emailAccountId },
    orderBy: { createdAt: "desc" },
    take: MAX_LISTED_MUTES,
    select: { id: true, threadId: true, createdAt: true },
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
        logger.warn("Failed to load muted thread", {
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
      mutedAt: row.createdAt.toISOString(),
      ...summaries[index],
    })),
  };
}

const MAX_LISTED_MUTES = 100;
const SUMMARY_CONCURRENCY = 5;
