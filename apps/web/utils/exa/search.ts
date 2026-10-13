import { z } from "zod";
import { env } from "@/env";
import { createScopedLogger, type Logger } from "@/utils/logger";

const EXA_SEARCH_URL = "https://api.exa.ai/search";
const EXA_TIMEOUT_MS = 15_000;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_MAX_TEXT_CHARACTERS = 1500;
const MAX_HIGHLIGHT_CHARACTERS = 1000;

const exaSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.string(),
      publishedDate: z.string().nullish(),
      author: z.string().nullish(),
      text: z.string().nullish(),
      highlights: z.array(z.string()).nullish(),
    }),
  ),
});

export type ExaSearchResult = {
  title: string;
  url: string;
  publishedDate?: string;
  author?: string;
  text?: string;
  highlights?: string[];
};

export function isExaSearchEnabled() {
  return Boolean(env.EXA_API_KEY);
}

export async function searchExa({
  query,
  numResults = DEFAULT_NUM_RESULTS,
  maxTextCharacters = DEFAULT_MAX_TEXT_CHARACTERS,
  logger = createScopedLogger("exa/search"),
}: {
  query: string;
  numResults?: number;
  maxTextCharacters?: number;
  logger?: Logger;
}): Promise<ExaSearchResult[]> {
  const apiKey = env.EXA_API_KEY;
  if (!apiKey) throw new Error("Exa search is not configured");

  logger.trace("Exa search query", { query });
  const startedAt = Date.now();

  const response = await fetch(EXA_SEARCH_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults,
      type: "auto",
      contents: {
        text: { maxCharacters: maxTextCharacters },
        highlights: { maxCharacters: MAX_HIGHLIGHT_CHARACTERS },
      },
    }),
    signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
  });

  if (!response.ok) {
    logger.error("Exa search request failed", { status: response.status });
    throw new Error(`Exa search failed with status ${response.status}`);
  }

  const parsed = exaSearchResponseSchema.safeParse(await response.json());
  if (!parsed.success) {
    logger.error("Exa search returned an unexpected response", {
      issues: parsed.error.issues.slice(0, 5),
    });
    throw new Error("Exa search returned an unexpected response");
  }

  const results = parsed.data.results.map(toSearchResult);
  logger.info("Exa search completed", {
    resultCount: results.length,
    durationMs: Date.now() - startedAt,
  });
  return results;
}

function toSearchResult(
  result: z.infer<typeof exaSearchResponseSchema>["results"][number],
): ExaSearchResult {
  return {
    title: result.title?.trim() || result.url,
    url: result.url,
    ...(result.publishedDate ? { publishedDate: result.publishedDate } : {}),
    ...(result.author ? { author: result.author } : {}),
    ...(result.text ? { text: result.text } : {}),
    ...(result.highlights?.length ? { highlights: result.highlights } : {}),
  };
}
