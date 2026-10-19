import {
  type ActionableThread,
  getListThreadKey,
} from "@/app/(app)/[emailAccountId]/mail/types";
import type { GetSearchIntentResponse } from "@/app/api/user/search-intent/route";
import { widenSearch } from "@/utils/mail-search/natural-language-search";

/**
 * How long the AI path of a search may take, from commit: reading the search
 * and the one widening step. Past it Cue stops waiting and shows what it has.
 */
export const CUE_SEARCH_BUDGET_MS = 4000;
/** Fewer matches than this and Cue widens the search, once. */
export const WIDEN_BELOW_RESULTS = 2;
/** The plain results a Cue found row would repeat on screen. */
export const PLAIN_ROWS_IN_VIEW = 5;

export type CueSearchIntent = NonNullable<GetSearchIntentResponse>;

/** "off" is a plain search, with no AI path. */
export type CueSearchStage =
  | "off"
  | "reading"
  | "searching"
  | "widening"
  | "done";

type WindowState = { settled: boolean; count: number };

/**
 * Where the AI path of a committed search is. `intent` is undefined while the
 * model reads the search and null when it gave nothing to run.
 */
export function getCueSearchStage({
  natural,
  intent,
  expired,
  primary,
  widening,
  widened,
}: {
  natural: boolean;
  intent: CueSearchIntent | null | undefined;
  expired: boolean;
  primary: WindowState;
  widening: boolean;
  widened: WindowState;
}): CueSearchStage {
  if (!natural) return "off";
  if (intent === undefined) return expired ? "off" : "reading";
  if (!intent?.searches.length) return "off";
  if (widening) return widened.settled || expired ? "done" : "widening";
  if (!primary.settled) return expired ? "done" : "searching";
  return "done";
}

/**
 * Whether to widen now: the searches have all answered with too little, a
 * wider search exists, and the budget isn't spent. The caller latches the
 * answer, so a search widens at most once.
 */
export function shouldWidenCueSearch({
  stage,
  primary,
  widerSearches,
  expired,
}: {
  stage: CueSearchStage;
  primary: WindowState;
  widerSearches: string[];
  expired: boolean;
}): boolean {
  return (
    stage === "done" &&
    !expired &&
    primary.settled &&
    primary.count < WIDEN_BELOW_RESULTS &&
    widerSearches.length > 0
  );
}

/** One wider version of each search, without repeats of the originals. */
export function getWiderSearches(searches: string[]): string[] {
  const wider = searches.flatMap((search) => {
    const widened = widenSearch(search);
    return widened && !searches.includes(widened) ? [widened] : [];
  });
  return [...new Set(wider)];
}

export type SearchAnswerRequest = { query: string; searches?: string[] };

/**
 * What the answer card asks for. A search typed as a sentence waits for Cue's
 * reading of it, and only a question is answered, from the searches Cue made,
 * so the model is never asked twice. Without a reading it falls back to the
 * typed words, as a plain search does.
 */
export function getSearchAnswerRequest({
  query,
  natural,
  intent,
  stage,
}: {
  query: string | null;
  natural: boolean;
  intent: CueSearchIntent | null | undefined;
  stage: CueSearchStage;
}): SearchAnswerRequest | null {
  if (!query) return null;
  if (!natural) return { query };
  if (stage === "reading") return null;
  if (!intent) return { query };
  if (!intent.isQuestion) return null;
  return intent.searches.length
    ? { query, searches: intent.searches }
    : { query };
}

/**
 * The rows the budget left on screen: once it's spent, mail the searches
 * find later stays out, so nothing lands above results being read. The rows
 * kept still show their latest state.
 */
export function keepFrozenRows<T extends ActionableThread>(
  threads: T[],
  frozenKeys: string[] | null,
): T[] {
  if (!frozenKeys) return threads;
  const kept = new Set(frozenKeys);
  return threads.filter((thread) => kept.has(getListThreadKey(thread)));
}

/**
 * Cue's rows less the ones the first plain results already show, so no
 * conversation appears twice on screen. The plain list itself is untouched,
 * which keeps its keyboard positions.
 */
export function withoutPlainDuplicates<T extends ActionableThread>(
  cueThreads: T[],
  plainThreads: ActionableThread[],
): T[] {
  const shown = new Set(
    plainThreads.slice(0, PLAIN_ROWS_IN_VIEW).map(getListThreadKey),
  );
  return cueThreads.filter((thread) => !shown.has(getListThreadKey(thread)));
}
