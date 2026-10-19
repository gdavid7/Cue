import { NextResponse } from "next/server";
import { z } from "zod";
import { getThreadBrief } from "@/utils/home/get-thread-brief";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";

const threadBriefQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
});

export type GetThreadBriefResponse = {
  brief: Awaited<ReturnType<typeof getThreadBrief>>;
};

export const maxDuration = 300;

export const GET = withEmailProvider("user/thread-brief", async (request) => {
  const { searchParams } = new URL(request.url);
  const { threadId } = threadBriefQuery.parse({
    threadId: searchParams.get("threadId"),
  });
  const emailAccountId = request.auth.emailAccountId;

  // Every request is a model call: the browser keeps briefs it was given and
  // asks again only for a conversation with a new message (RD-3).
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
