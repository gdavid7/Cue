import { NextResponse } from "next/server";
import { z } from "zod";
import { interpretSearch } from "@/utils/ai/mail-search/interpret-search";
import { MAX_SEARCH_QUERY_LENGTH } from "@/utils/mail-search/natural-language-search";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";

const searchIntentQuery = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
});

export type GetSearchIntentResponse = Awaited<
  ReturnType<typeof interpretSearch>
>;

// Shares the 30s group: on the Hobby plan each distinct route config is a
// separate function, and a deployment may hold at most 12.
export const maxDuration = 30;

export const GET = withEmailProvider(
  "user/search-intent",
  async (request) => {
    const { q } = searchIntentQuery.parse({
      q: new URL(request.url).searchParams.get("q"),
    });
    // Each committed search typed as a sentence makes one model call.
    await assertWithinUserRateLimit({
      scope: "search-intent",
      userId: request.auth.userId,
      limit: 60,
      windowSeconds: 5 * 60,
      logger: request.logger,
    });

    return NextResponse.json(
      (await interpretSearch({
        emailAccountId: request.auth.emailAccountId,
        query: q,
        emailProvider: request.emailProvider,
        logger: request.logger,
      })) satisfies GetSearchIntentResponse,
    );
  },
  { maxDuration },
);
