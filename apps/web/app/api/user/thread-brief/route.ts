import { NextResponse } from "next/server";
import { z } from "zod";
import { getThreadBrief } from "@/utils/home/get-thread-brief";
import { withEmailProvider } from "@/utils/middleware";

const threadBriefQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
});

export type GetThreadBriefResponse = {
  brief: Awaited<ReturnType<typeof getThreadBrief>>;
};

export const maxDuration = 300;

export const GET = withEmailProvider("user/thread-brief", async (request) => {
  const { threadId } = threadBriefQuery.parse({
    threadId: new URL(request.url).searchParams.get("threadId"),
  });

  const brief = await getThreadBrief({
    emailAccountId: request.auth.emailAccountId,
    threadId,
    emailProvider: request.emailProvider,
    logger: request.logger,
  });
  return NextResponse.json({ brief } satisfies GetThreadBriefResponse);
});
