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
      ownEmail: request.auth.email,
      provider: request.emailProvider,
      logger: request.logger,
    }),
  ),
);

async function listMutedThreads({
  emailAccountId,
  ownEmail,
  provider,
  logger,
}: {
  emailAccountId: string;
  ownEmail: string;
  provider: EmailProvider;
  logger: Logger;
}) {
  const rows = await prisma.mutedThread.findMany({
    where: { emailAccountId },
    orderBy: { createdAt: "desc" },
    take: MAX_LISTED_MUTES,
    select: { id: true, threadId: true, createdAt: true },
  });

  // The rows only know thread ids; the provider supplies what each one is,
  // from headers alone, and nothing of it is stored or cached here (R-1).
  const summaries = await mapWithConcurrency(
    rows,
    SUMMARY_CONCURRENCY,
    async (row) => {
      try {
        return (
          (await provider.getThreadHeadline(row.threadId, ownEmail)) ?? {
            subject: "",
            from: "",
            snippet: "",
          }
        );
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

// The newest mutes only: each costs a provider read, so the view is capped
// rather than paginated (follow-up if people mute more than this).
const MAX_LISTED_MUTES = 100;
const SUMMARY_CONCURRENCY = 5;
