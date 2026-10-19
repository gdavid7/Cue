import { NextResponse } from "next/server";
import { z } from "zod";
import { isExaSearchEnabled } from "@/utils/exa/search";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import {
  getSuggestedReplySettings,
  suggestReply,
} from "@/utils/thread-context/suggest-reply";

const suggestedReplyQuery = z.object({
  threadId: z.string().trim().min(1).max(512),
  web: z.literal("1").nullish(),
  /**
   * The public query the plain pass's abstention asked for, kept by the
   * browser so the web pass needn't write the plain answer again.
   */
  webQuery: z.string().trim().min(1).max(300).nullish(),
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
    const { threadId, web, webQuery } = suggestedReplyQuery.parse({
      threadId: searchParams.get("threadId"),
      web: searchParams.get("web"),
      webQuery: searchParams.get("webQuery"),
    });

    // Only the web pass is limited: it calls a model and a web search for
    // every thread mail and calendar couldn't answer.
    if (web === "1") {
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
    // Every request works a suggestion out: the browser keeps the ones it
    // was given, and the server keeps none (RD-3).
    const suggestion = await suggestReply({
      emailAccountId: request.auth.emailAccountId,
      userEmail: request.auth.email,
      threadId,
      emailProvider: request.emailProvider,
      logger: request.logger,
      searchWeb: web === "1",
      webQuery: webQuery ?? undefined,
      settings,
    });
    return NextResponse.json({
      suggestion,
      canSearchWeb: isExaSearchEnabled() && settings.webLookupEnabled,
    } satisfies GetSuggestedReplyResponse);
  },
);
