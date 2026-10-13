import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { getThreadContext } from "@/utils/thread-context/get-thread-context";

const threadContextQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
});

export type GetThreadContextResponse = Awaited<
  ReturnType<typeof getThreadContext>
>;

export const maxDuration = 30;

export const GET = withEmailProvider("user/thread-context", async (request) => {
  const { threadId } = threadContextQuery.parse({
    threadId: new URL(request.url).searchParams.get("threadId"),
  });

  return NextResponse.json(
    await getThreadContext({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      threadId,
      emailProvider: request.emailProvider,
      logger: request.logger,
    }),
  );
});
