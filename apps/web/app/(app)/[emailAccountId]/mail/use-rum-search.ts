import { useEffect } from "react";
import {
  beginRumAction,
  cancelRumAction,
  completeRumAction,
} from "@/utils/analytics/rum-actions";

type SearchResults = {
  hasRows: boolean;
  /** Settled with nothing found. */
  empty: boolean;
};

type SearchCommit = {
  id: string;
  query: string;
  startedAt: number;
  cueBegun: boolean;
};

let commitCount = 0;
let commit: SearchCommit | null = null;
let shownQuery: string | null = null;

/**
 * Called on each committed search (Enter), with the trimmed query, or null
 * when the search is cleared. Every commit gets its own key, so results left
 * over from an earlier search never end it. Committing the search already on
 * screen waits for nothing and is not timed.
 */
export function noteRumSearchCommit(query: string | null) {
  if (!query) {
    commit = null;
    cancelRumAction("search_plain");
    cancelRumAction("search_cue_found");
    return;
  }
  if (query === shownQuery) return;
  commitCount += 1;
  const startedAt = performance.now();
  commit = { id: String(commitCount), query, startedAt, cueBegun: false };
  cancelRumAction("search_cue_found");
  beginRumAction("search_plain", { key: commit.id, startedAt });
}

/**
 * Ends the timings `noteRumSearchCommit` began, from the results of the
 * committed search itself. "Cue found" is timed only once Cue's search is
 * running for it, from the same Enter.
 */
export function useRumSearch({
  committedQuery,
  plain,
  plainError,
  cue,
}: {
  /** The committed search whose results are on screen, if any. */
  committedQuery: string | null;
  /** Results of the committed search's own list, once it has answered. */
  plain: SearchResults;
  plainError: boolean;
  /** `active` is whether Cue's search is running for this search. */
  cue: SearchResults & { active: boolean };
}) {
  shownQuery = committedQuery;

  useEffect(() => {
    const current = commit;
    if (!current || current.query !== committedQuery) return;
    const key = current.id;
    if (plainError) {
      completeRumAction("search_plain", { key, outcome: "error" });
    } else if (plain.hasRows) {
      completeRumAction("search_plain", { key });
    } else if (plain.empty) {
      completeRumAction("search_plain", { key, outcome: "empty" });
    }
    if (!cue.active) return;
    if (!current.cueBegun) {
      current.cueBegun = true;
      beginRumAction("search_cue_found", {
        key,
        startedAt: current.startedAt,
      });
    }
    if (cue.hasRows) completeRumAction("search_cue_found", { key });
    else if (cue.empty) {
      completeRumAction("search_cue_found", { key, outcome: "empty" });
    }
  }, [
    committedQuery,
    plainError,
    plain.hasRows,
    plain.empty,
    cue.active,
    cue.hasRows,
    cue.empty,
  ]);
}

export function resetRumSearchForTesting() {
  commit = null;
  commitCount = 0;
  shownQuery = null;
}
