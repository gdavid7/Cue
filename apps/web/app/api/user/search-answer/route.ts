import { NextResponse } from "next/server";
import { z } from "zod";
import {
  MAX_GENERATED_SEARCHES,
  MAX_SEARCH_QUERY_LENGTH,
} from "@/utils/mail-search/natural-language-search";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { answerSearch } from "@/utils/thread-context/search-answer";

const searchAnswerQuery = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  // What /api/user/search-intent made of a question typed as a sentence.
  s: z
    .array(z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH))
    .max(MAX_GENERATED_SEARCHES),
});

export type GetSearchAnswerResponse = Awaited<ReturnType<typeof answerSearch>>;

export const maxDuration = 30;

export const GET = withEmailProvider(
  "user/search-answer",
  async (request) => {
    const { searchParams } = new URL(request.url);
    const { q, s } = searchAnswerQuery.parse({
      q: searchParams.get("q"),
      s: searchParams.getAll("s"),
    });
    // Each new question searches mail and connected apps, then calls a model.
    await assertWithinUserRateLimit({
      scope: "search-answer",
      userId: request.auth.userId,
      limit: 60,
      windowSeconds: 5 * 60,
      logger: request.logger,
    });

    return NextResponse.json(
      (await answerSearch({
        emailAccountId: request.auth.emailAccountId,
        userEmail: request.auth.email,
        query: q,
        searches: s.length ? s : undefined,
        emailProvider: request.emailProvider,
        logger: request.logger,
      })) satisfies GetSearchAnswerResponse,
    );
  },
  { maxDuration },
);
