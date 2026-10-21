"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import useSWR from "swr";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  type AccountSearchPhase,
  type CueSearchAccount,
  getAccountCueSearches,
  getAccountsCuePredicate,
  getCueRankingSearch,
  getFinishedProviderSearches,
  keepFrozenRowsFirst,
  scheduleAccountSearches,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import {
  CUE_SEARCH_BUDGET_MS,
  type CueSearchIntent,
  getCueSearchStage,
  getSearchAnswerRequest,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";
import { rankCueFoundThreads } from "@/app/(app)/[emailAccountId]/mail/cue-search-ranking";
import {
  getListThreadKey,
  type ListThread,
} from "@/app/(app)/[emailAccountId]/mail/types";
import { useEngineMailThreads } from "@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads";
import type { GetSearchIntentResponse } from "@/app/api/user/search-intent/route";
import type { EmailLabels } from "@/providers/email-label-types";
import { swrFetcher } from "@/providers/swr-fetcher";
import { looksLikeNaturalLanguage } from "@/utils/mail-search/natural-language-search";
import type { ThreadsQuery } from "@/utils/threads/validation";

const SEARCH_INTENT_PATH = "/api/user/search-intent";
const MAX_LABELS = 300;
const NO_THREADS: ListThread[] = [];
const NO_ACCOUNTS: AllInboxesAccount[] = [];
// The predicate carries the searches; the query only names the window.
const PREDICATE_ONLY_QUERY: ThreadsQuery = { q: "" };

type Run = {
  query: string;
  expired: boolean;
  /** The model hadn't answered when the budget ran out. */
  readingLate: boolean;
  /** The rows on screen when the budget ran out. */
  frozenKeys: string[] | null;
  /** When each account's provider search began. */
  startedAtMs: Record<string, number>;
  /** Accounts whose provider has answered, or never will. */
  finished: string[];
};

/**
 * Cue's search of a sentence typed in All inboxes. The model reads it once,
 * and that reading becomes a search in each included account's own syntax
 * and labels. Every account's local mail is read at once; their providers a
 * few at a time, each within a time box, so a slow account never holds up
 * the others. What they find is ranked together on one scale and each row
 * keeps its account, so it opens there. Accounts left out of All inboxes are
 * never searched.
 */
export function useAllInboxesCueSearch({
  emailAccountId,
  accounts,
  labelsByAccount,
  query,
  enabled,
}: {
  /** The routed account, which reads the search. */
  emailAccountId: string;
  /** The accounts included in All inboxes. */
  accounts: AllInboxesAccount[];
  labelsByAccount: Record<string, EmailLabels>;
  /** The committed search, never the text being typed. */
  query: string | null;
  /** Off for users without AI and outside All inboxes. */
  enabled: boolean;
}) {
  const natural = Boolean(enabled && query && looksLikeNaturalLanguage(query));
  const searchAccounts = useMemo<CueSearchAccount[]>(
    () =>
      accounts.map((account) => ({
        id: account.id,
        provider: account.provider,
        labels: Object.values(labelsByAccount[account.id] ?? {}).map(
          (label) => ({
            id: label.id,
            name: label.name,
            accountId: account.id,
          }),
        ),
      })),
    [accounts, labelsByAccount],
  );
  // Every account's label names, so the searches Cue shows can name a label
  // any of them has. A ref, not part of the key: a label that loads later
  // mustn't read the search again.
  const labelNamesRef = useRef<string[]>([]);
  labelNamesRef.current = [
    ...new Set(
      searchAccounts.flatMap((account) =>
        account.labels.map((label) => label.name),
      ),
    ),
  ].slice(0, MAX_LABELS);
  // The same key a single account's search uses: one model call per search.
  const { data, error } = useSWR<GetSearchIntentResponse>(
    natural && query
      ? ([SEARCH_INTENT_PATH, emailAccountId, query] as const)
      : null,
    ([path, accountId, q]: readonly [string, string, string]) =>
      swrFetcher(
        path,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ q, labels: labelNamesRef.current }),
        },
        accountId,
      ),
    { revalidateOnFocus: false, shouldRetryOnError: false },
  );
  const answered = data !== undefined || error !== undefined;

  const answeredRef = useRef(answered);
  const rowKeysRef = useRef<string[]>([]);
  const [run, setRun] = useState<Run | null>(null);
  useEffect(() => {
    answeredRef.current = answered;
  }, [answered]);
  // The budget runs from commit, as for one account. Past it the rows on
  // screen hold their place, and a slower account's mail lands below them.
  useEffect(() => {
    if (!natural || !query) return;
    setRun({
      query,
      expired: false,
      readingLate: false,
      frozenKeys: null,
      startedAtMs: {},
      finished: [],
    });
    const timeout = setTimeout(() => {
      setRun((current) =>
        current?.query === query
          ? {
              ...current,
              expired: true,
              readingLate: !answeredRef.current,
              frozenKeys: rowKeysRef.current,
            }
          : current,
      );
    }, CUE_SEARCH_BUDGET_MS);
    return () => clearTimeout(timeout);
  }, [natural, query]);
  const current = run?.query === query ? run : null;
  const expired = Boolean(current?.expired);
  let intent: CueSearchIntent | null | undefined;
  if (answered && !current?.readingLate) intent = data ?? null;

  // Once per reading, so its dates, and recency, hold still.
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new reading is a new now
  const now = useMemo(() => new Date(), [intent]);
  const timeZone = intent?.timeZone ?? "UTC";
  const searches = useMemo(
    () =>
      intent?.parts
        ? getAccountCueSearches(intent.parts, searchAccounts, {
            now,
            timeZone,
          })
        : [],
    [intent, searchAccounts, now, timeZone],
  );
  const searchedIds = useMemo(
    () => searches.map((search) => search.accountId),
    [searches],
  );

  // Which accounts' providers search now. It looks again whenever one
  // answers, and when the next one's time box runs out.
  const [clockMs, setClockMs] = useState(() => Date.now());
  const startedAtMs = current?.startedAtMs;
  const finishedIds = useMemo(
    () => new Set(current?.finished),
    [current?.finished],
  );
  const schedule = useMemo(
    () =>
      scheduleAccountSearches({
        accountIds: searchedIds,
        startedAtMs: startedAtMs ?? {},
        finishedIds,
        nowMs: clockMs,
      }),
    [searchedIds, startedAtMs, finishedIds, clockMs],
  );
  const { phases, toStart, nextDeadlineMs } = schedule;
  useEffect(() => {
    if (!toStart.length || !query) return;
    const startedAt = Date.now();
    setRun((run) =>
      run?.query === query
        ? {
            ...run,
            startedAtMs: {
              ...run.startedAtMs,
              ...Object.fromEntries(toStart.map((id) => [id, startedAt])),
            },
          }
        : run,
    );
  }, [toStart, query]);
  useEffect(() => {
    if (nextDeadlineMs === null) return;
    const timeout = setTimeout(
      () => setClockMs(Date.now()),
      Math.max(0, nextDeadlineMs - Date.now()),
    );
    return () => clearTimeout(timeout);
  }, [nextDeadlineMs]);

  const providerAccountIds = useMemo(
    () =>
      new Set(
        searchedIds.filter(
          (id) => phases[id] === "searching" || phases[id] === "finished",
        ),
      ),
    [searchedIds, phases],
  );
  const predicate = useMemo(
    () =>
      getAccountsCuePredicate({
        searches,
        accounts: searchAccounts,
        providerAccountIds,
        unreadOnly: Boolean(intent?.parts?.unread),
        now,
        timeZone,
      }),
    [searches, searchAccounts, providerAccountIds, intent, now, timeZone],
  );
  const accountsById = useMemo(
    () => Object.fromEntries(accounts.map((account) => [account.id, account])),
    [accounts],
  );
  const state = useEngineMailThreads({
    emailAccountId,
    accountIds: searchedIds.length ? searchedIds : [emailAccountId],
    accounts: accountsById,
    query: PREDICATE_ONLY_QUERY,
    predicate,
    enabled: natural && Boolean(predicate),
  });

  const answeredByProvider = getFinishedProviderSearches(
    state.providerSearchAccounts,
  ).filter((id) => providerAccountIds.has(id) && !finishedIds.has(id));
  const answeredKey = answeredByProvider.join("\n");
  useEffect(() => {
    if (!answeredKey || !query) return;
    const ids = answeredKey.split("\n");
    setRun((run) =>
      run?.query === query
        ? { ...run, finished: [...new Set([...run.finished, ...ids])] }
        : run,
    );
  }, [answeredKey, query]);

  // An account's turn to search its provider changes the window's query;
  // its rows stay while the new window loads, so they don't blink out.
  const heldRef = useRef<{ query: string | null; threads: ListThread[] }>({
    query: null,
    threads: NO_THREADS,
  });
  let windowThreads = state.threads;
  if (state.isLoading && heldRef.current.query === query)
    windowThreads = heldRef.current.threads;
  else if (!state.isLoading)
    heldRef.current = { query, threads: windowThreads };

  const ranking = useMemo(
    () => ({
      searches: intent?.parts
        ? getCueRankingSearch(intent.parts, { now, timeZone })
        : [],
      labels: searchAccounts.flatMap((account) => account.labels),
      now,
      timeZone,
      provider: "google" as const,
    }),
    [intent, searchAccounts, now, timeZone],
  );
  const liveThreads = useMemo(
    () => rankCueFoundThreads(windowThreads, ranking),
    [windowThreads, ranking],
  );
  useEffect(() => {
    rowKeysRef.current = liveThreads.map(getListThreadKey);
  }, [liveThreads]);
  const frozenKeys = current?.frozenKeys ?? null;
  const threads = useMemo(
    () => keepFrozenRowsFirst(liveThreads, frozenKeys),
    [liveThreads, frozenKeys],
  );

  // As a string, so the same accounts keep the same list from render to render.
  const pendingKey = searchedIds
    .filter((id) => isPending(phases[id]))
    .join("\n");
  const settled =
    natural &&
    Boolean(predicate) &&
    state.hasRemoteResponse &&
    !state.isLoading &&
    !pendingKey;
  const stage = getCueSearchStage({
    natural,
    intent: intent && {
      ...intent,
      searches: searches.map(({ search }) => search),
    },
    expired,
    primary: { settled, count: liveThreads.length },
    widening: false,
    widened: { settled: false, count: 0 },
  });
  const stillSearching = useMemo(() => {
    if (stage !== "done" || !pendingKey) return NO_ACCOUNTS;
    const pending = new Set(pendingKey.split("\n"));
    return accounts.filter((account) => pending.has(account.id));
  }, [stage, pendingKey, accounts]);

  return {
    natural,
    stage,
    intent: intent ?? null,
    threads,
    foundNothing: stage === "done" && settled && !liveThreads.length,
    widening: null,
    answerRequest: getSearchAnswerRequest({ query, natural, intent, stage }),
    /** Accounts Cue is still searching once it has shown what it found. */
    stillSearching,
  };
}

function isPending(phase: AccountSearchPhase | undefined) {
  return phase === "waiting" || phase === "searching";
}
