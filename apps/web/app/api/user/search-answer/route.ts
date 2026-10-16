import { NextResponse } from "next/server";
import { z } from "zod";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";
import { answerSearch } from "@/utils/thread-context/search-answer";

const searchAnswerQuery = z.object({
  q: z.string().trim().min(1).max(300),
});

export type GetSearchAnswerResponse = Awaited<ReturnType<typeof answerSearch>>;

export const maxDuration = 30;

export const GET = withEmailProvider(
  "user/search-answer",
  async (request) => {
    const { q } = searchAnswerQuery.parse({
      q: new URL(request.url).searchParams.get("q"),
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
        emailProvider: request.emailProvider,
        logger: request.logger,
      })) satisfies GetSearchAnswerResponse,
    );
  },
  { maxDuration },
);
