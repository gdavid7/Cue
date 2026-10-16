import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getCachedThreadBrief,
  getThreadBrief,
} from "@/utils/home/get-thread-brief";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";

const threadBriefQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
  /** The newest message the caller shows, to answer from the cache alone. */
  messageId: z.string().trim().min(1).max(512).nullish(),
});

export type GetThreadBriefResponse = {
  brief: Awaited<ReturnType<typeof getThreadBrief>>;
};

export const maxDuration = 300;

export const GET = withEmailProvider("user/thread-brief", async (request) => {
  const { searchParams } = new URL(request.url);
  const { threadId, messageId } = threadBriefQuery.parse({
    threadId: searchParams.get("threadId"),
    messageId: searchParams.get("messageId"),
  });
  const emailAccountId = request.auth.emailAccountId;

  // Reopening a conversation reads the cache and nothing else: no provider
  // read, no model call, and no rate-limit charge.
  const cached = messageId
    ? await getCachedThreadBrief({ emailAccountId, threadId, messageId })
    : null;
  if (cached) {
    return NextResponse.json({
      brief: cached,
    } satisfies GetThreadBriefResponse);
  }

  // An uncached brief is a model call.
  await assertWithinUserRateLimit({
    scope: "thread-brief",
    userId: request.auth.userId,
    limit: 120,
    windowSeconds: 5 * 60,
    logger: request.logger,
  });

  const brief = await getThreadBrief({
    emailAccountId,
    threadId,
    emailProvider: request.emailProvider,
    logger: request.logger,
  });
  return NextResponse.json({ brief } satisfies GetThreadBriefResponse);
});
