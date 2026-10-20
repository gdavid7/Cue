import {
  type ActionableThread,
  getListThreadKey,
} from "@/app/(app)/[emailAccountId]/mail/types";
import type { GetSearchIntentResponse } from "@/app/api/user/search-intent/route";
import {
  WIDENING_TIERS,
  type WideningTier,
  widenSearchByTier,
} from "@/utils/mail-search/natural-language-search";

/**
 * How long the AI path of a search may take, from commit: reading the search
 * and widening it. Past it Cue stops waiting and shows what it has.
 */
export const CUE_SEARCH_BUDGET_MS = 4000;
/** Fewer matches than this and Cue widens the search, tier by tier. */
export const WIDEN_BELOW_RESULTS = 2;
/** Conversations the search by meaning may add: a screen and a half. */
export const CUE_SEMANTIC_RESULTS = 15;
/** The Cue found rows shown before "Show all". */
export const CUE_FOUND_VISIBLE_ROWS = 3;

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

/** One tier of widening, and the searches Cue runs for it, all at once. */
export type WideningStep = { tier: WideningTier; searches: string[] };
/**
 * The tier Cue widened to. `onProvider` is the last resort: no local search
 * found any mail, so the last tier's searches went to the provider too.
 */
export type CueWidening = WideningStep & { onProvider: boolean };

/**
 * The tiers a search widens through, in order, each with the wider searches
 * of every one of Cue's searches. A search already run is never run again,
 * and a tier with nothing new is left out, so widening reads the local mail
 * at most once per tier.
 */
export function getWideningLadder(
  searches: string[],
  context: Parameters<typeof widenSearchByTier>[1],
): WideningStep[] {
  const ran = new Set(searches);
  const byTier = searches.map((search) => widenSearchByTier(search, context));
  return WIDENING_TIERS.flatMap((tier) => {
    const tierSearches = [
      ...new Set(byTier.flatMap((tiers) => tiers[tier])),
    ].filter((search) => !ran.has(search));
    for (const search of tierSearches) ran.add(search);
    return tierSearches.length ? [{ tier, searches: tierSearches }] : [];
  });
}

/**
 * The ladder step Cue should be on: none until the searches have all
 * answered with too little, then the first tier, and each next tier while
 * the current one has answered with no mail the earlier searches didn't
 * find. It stops at the first tier that finds some, at the top of the
 * ladder, and once the budget is spent.
 */
export function getWideningStep({
  step,
  primary,
  widened,
  ladderLength,
  expired,
}: {
  /** The current step, null before widening. */
  step: number | null;
  primary: WindowState;
  /** The current step's search; `count` is the mail new to it. */
  widened: WindowState;
  ladderLength: number;
  expired: boolean;
}): number | null {
  if (expired) return step;
  if (step === null) {
    return primary.settled &&
      primary.count < WIDEN_BELOW_RESULTS &&
      ladderLength > 0
      ? 0
      : null;
  }
  return widened.settled && widened.count === 0 && step + 1 < ladderLength
    ? step + 1
    : step;
}

/**
 * Whether to send the ladder's last tier to the provider, once: every
 * search has answered and none found any mail, the first (which the
 * provider answered too) or any tier (which read the local mail alone). It
 * finds mail older than an account's local copy reaches.
 */
export function shouldAskProviderLastResort({
  step,
  primary,
  widened,
  ladderLength,
  expired,
}: Parameters<typeof getWideningStep>[0]): boolean {
  return (
    !expired &&
    step !== null &&
    step === ladderLength - 1 &&
    primary.settled &&
    primary.count === 0 &&
    widened.settled &&
    widened.count === 0
  );
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
  const shown = new Set(plainThreads.map(getListThreadKey));
  return cueThreads.filter((thread) => !shown.has(getListThreadKey(thread)));
}
