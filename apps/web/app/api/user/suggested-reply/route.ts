import { NextResponse } from "next/server";
import { z } from "zod";
import { isExaSearchEnabled } from "@/utils/exa/search";
import { withEmailProvider } from "@/utils/middleware";
import { suggestReply } from "@/utils/thread-context/suggest-reply";

const suggestedReplyQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
  web: z.literal("1").nullish(),
});

export type GetSuggestedReplyResponse = {
  suggestion: Awaited<ReturnType<typeof suggestReply>>;
  /** Whether an abstention can be retried with a web search. */
  canSearchWeb: boolean;
};

export const maxDuration = 60;

export const GET = withEmailProvider(
  "user/suggested-reply",
  async (request) => {
    const { searchParams } = new URL(request.url);
    const { threadId, web } = suggestedReplyQuery.parse({
      threadId: searchParams.get("threadId"),
      web: searchParams.get("web"),
    });

    const suggestion = await suggestReply({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      threadId,
      emailProvider: request.emailProvider,
      logger: request.logger,
      searchWeb: web === "1",
    });
    return NextResponse.json({
      suggestion,
      canSearchWeb: isExaSearchEnabled(),
    } satisfies GetSuggestedReplyResponse);
  },
);
