import { z } from "zod";
import { env } from "@/env";
import { createScopedLogger, type Logger } from "@/utils/logger";

const EXA_TIMEOUT_MS = 15_000;
const DEFAULT_NUM_RESULTS = 5;
const DEFAULT_MAX_TEXT_CHARACTERS = 1500;
const MAX_HIGHLIGHT_CHARACTERS = 1000;

const exaResultsSchema = z.object({
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
  startPublishedDate,
  logger = createScopedLogger("exa/search"),
}: {
  query: string;
  numResults?: number;
  maxTextCharacters?: number;
  /** Only pages published after this, e.g. for recent news. */
  startPublishedDate?: Date;
  logger?: Logger;
}): Promise<ExaSearchResult[]> {
  logger.trace("Exa search query", { query });
  const startedAt = Date.now();
  const results = await exaRequest(
    "/search",
    {
      query,
      numResults,
      type: "auto",
      ...(startPublishedDate
        ? { startPublishedDate: startPublishedDate.toISOString() }
        : {}),
      contents: {
        text: { maxCharacters: maxTextCharacters },
        highlights: { maxCharacters: MAX_HIGHLIGHT_CHARACTERS },
      },
    },
    logger,
  );
  logger.info("Exa search completed", {
    resultCount: results.length,
    durationMs: Date.now() - startedAt,
  });
  return results;
}

/**
 * The text of public pages by URL. Exa leaves a page it can't fetch out of
 * the results, so one dead link doesn't fail the others.
 */
export async function getExaContents({
  urls,
  maxTextCharacters = DEFAULT_MAX_TEXT_CHARACTERS,
  logger = createScopedLogger("exa/contents"),
}: {
  urls: string[];
  maxTextCharacters?: number;
  logger?: Logger;
}): Promise<ExaSearchResult[]> {
  if (!urls.length) return [];
  logger.trace("Exa contents request", { urls });
  return exaRequest(
    "/contents",
    { urls, text: { maxCharacters: maxTextCharacters } },
    logger,
  );
}

async function exaRequest(
  path: "/search" | "/contents",
  body: Record<string, unknown>,
  logger: Logger,
): Promise<ExaSearchResult[]> {
  const apiKey = env.EXA_API_KEY;
  if (!apiKey) throw new Error("Exa search is not configured");

  const response = await fetch(`${env.EXA_API_URL}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(EXA_TIMEOUT_MS),
  });

  if (!response.ok) {
    logger.error("Exa request failed", { path, status: response.status });
    throw new Error(`Exa ${path} failed with status ${response.status}`);
  }

  const parsed = exaResultsSchema.safeParse(await response.json());
  if (!parsed.success) {
    logger.error("Exa returned an unexpected response", {
      path,
      issues: parsed.error.issues.slice(0, 5),
    });
    throw new Error("Exa returned an unexpected response");
  }
  return parsed.data.results.map(toSearchResult);
}

function toSearchResult(
  result: z.infer<typeof exaResultsSchema>["results"][number],
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
