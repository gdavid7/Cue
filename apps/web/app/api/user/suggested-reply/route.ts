import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { suggestReply } from "@/utils/thread-context/suggest-reply";

const suggestedReplyQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
});

export type GetSuggestedReplyResponse = {
  suggestion: Awaited<ReturnType<typeof suggestReply>>;
};

export const maxDuration = 60;

export const GET = withEmailProvider(
  "user/suggested-reply",
  async (request) => {
    const { threadId } = suggestedReplyQuery.parse({
      threadId: new URL(request.url).searchParams.get("threadId"),
    });

    const suggestion = await suggestReply({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      threadId,
      emailProvider: request.emailProvider,
      logger: request.logger,
    });
    return NextResponse.json({
      suggestion,
    } satisfies GetSuggestedReplyResponse);
  },
);
