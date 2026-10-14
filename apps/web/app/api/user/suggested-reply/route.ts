import { NextResponse } from "next/server";
import { z } from "zod";
import { isExaSearchEnabled } from "@/utils/exa/search";
import { withEmailProvider } from "@/utils/middleware";
import prisma from "@/utils/prisma";
import {
  getCachedSuggestedReply,
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

    const [suggestion, settings] = await Promise.all([
      cachedFor
        ? getCachedSuggestedReply({
            emailAccountId: request.auth.emailAccountId,
            threadId,
            messageId: cachedFor,
          })
        : suggestReply({
            emailAccountId: request.auth.emailAccountId,
            userEmail: request.auth.email,
            threadId,
            emailProvider: request.emailProvider,
            logger: request.logger,
            searchWeb: web === "1",
          }),
      prisma.emailAccount.findUnique({
        where: { id: request.auth.emailAccountId },
        select: { webLookupEnabled: true },
      }),
    ]);
    return NextResponse.json({
      suggestion,
      canSearchWeb: isExaSearchEnabled() && Boolean(settings?.webLookupEnabled),
    } satisfies GetSuggestedReplyResponse);
  },
);
