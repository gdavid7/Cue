import { NextResponse } from "next/server";
import { z } from "zod";
import { interpretSearch } from "@/utils/ai/mail-search/interpret-search";
import { MAX_SEARCH_QUERY_LENGTH } from "@/utils/mail-search/natural-language-search";
import { withEmailProvider } from "@/utils/middleware";
import { assertWithinUserRateLimit } from "@/utils/rate-limit";

const MAX_LABEL_NAME_LENGTH = 200;
const MAX_LABELS = 300;

const searchIntentBody = z.object({
  q: z.string().trim().min(1).max(MAX_SEARCH_QUERY_LENGTH),
  // Sent by the browser, which already holds the account's labels, so the
  // route needs no provider call for them and keeps no copy of them.
  labels: z.array(z.string().max(MAX_LABEL_NAME_LENGTH)).max(MAX_LABELS),
});

export type GetSearchIntentResponse = Awaited<
  ReturnType<typeof interpretSearch>
>;

export const maxDuration = 15;

// A POST only to carry the labels: it reads, and changes nothing.
export const POST = withEmailProvider(
  "user/search-intent",
  async (request) => {
    const { q, labels } = searchIntentBody.parse(await request.json());
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
        provider: request.emailProvider.name,
        labelNames: labels,
        logger: request.logger,
      })) satisfies GetSearchIntentResponse,
    );
  },
  { maxDuration },
);
