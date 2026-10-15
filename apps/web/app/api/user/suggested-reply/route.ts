import { NextResponse } from "next/server";
import { z } from "zod";
import { isExaSearchEnabled } from "@/utils/exa/search";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import {
  getCachedSuggestedReply,
  getSuggestedReplySettings,
  suggestReply,
} from "@/utils/thread-context/suggest-reply";

const suggestedReplyQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
  web: z.literal("1").nullish(),
  /** Only the reply already worked out for this message, never a new one. */
  cachedFor: z.string().trim().min(1).max(512).nullish(),
});

export type GetSuggestedReplyResponse = {
  suggestion: Awaited<ReturnType<typeof suggestReply>>;
  /** Whether an abstention can be retried with a web search. */
  canSearchWeb: boolean;
};

export const maxDuration = 300;

export const GET = withEmailProvider(
  "user/suggested-reply",
  async (request) => {
    const { searchParams } = new URL(request.url);
    const { threadId, web, cachedFor } = suggestedReplyQuery.parse({
      threadId: searchParams.get("threadId"),
      web: searchParams.get("web"),
      cachedFor: searchParams.get("cachedFor"),
    });

    // Only the web pass is limited: it calls a model and a web search for
    // every thread mail and calendar couldn't answer.
    if (web === "1" && !cachedFor) {
      await assertWithinUserRateLimit({
        scope: "suggested-reply-web",
        userId: request.auth.userId,
        limit: 40,
        windowSeconds: 5 * 60,
        logger: request.logger,
      });
    }

    const settings = await getSuggestedReplySettings(
      request.auth.emailAccountId,
    );
    const suggestion = cachedFor
      ? await getCachedSuggestedReply(
          {
            emailAccountId: request.auth.emailAccountId,
            threadId,
            messageId: cachedFor,
          },
          settings,
        )
      : await suggestReply({
          emailAccountId: request.auth.emailAccountId,
          userEmail: request.auth.email,
          threadId,
          emailProvider: request.emailProvider,
          logger: request.logger,
          searchWeb: web === "1",
          settings,
        });
    return NextResponse.json({
      suggestion,
      canSearchWeb: isExaSearchEnabled() && settings.webLookupEnabled,
    } satisfies GetSuggestedReplyResponse);
  },
);
