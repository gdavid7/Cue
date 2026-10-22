import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR, {
  type Cache,
  type BareFetcher,
  unstable_serialize,
  useSWRConfig,
} from "swr";
import type { GetHomeDeadlinesResponse } from "@/app/api/user/home/deadlines/route";
import {
  keepShownLanes,
  type TodayHomeData,
} from "@/utils/home/keep-shown-lanes";
import { readCachedToday, writeCachedToday } from "@/utils/home/today-cache";
import { onTodayChanged } from "@/utils/home/today-changes";
import { getAccountScopedKey } from "@/utils/swr";

// A lane Gmail couldn't serve in time loads on a later request. A minute of
// asking is enough: past that the account's Gmail is busy for longer, and
// each ask spends its quota again.
const PENDING_REFRESH_MS = 5000;
const PENDING_LOAD_LIMIT = 12;
const FOCUS_REFRESH_MIN_MS = 30_000;
const CHANGE_REFRESH_MIN_MS = 10_000;

// Saved copies as they went into SWR's cache, so they aren't saved back.
const seededCopies = new WeakSet<TodayHomeData>();

/**
 * Today's data. It opens on what Today last showed in this browser, then
 * refreshes; a lane Gmail is slow to serve keeps its rows meanwhile.
 * `gaveUp` is set once a lane has stayed pending through every refresh;
 * `retry` asks again from the start.
 */
export function useHome(emailAccountId?: string | null) {
  // Loads in a row that came back with a lane still pending. SWR may call
  // refreshInterval from an earlier render, so it reads the ref.
  const pendingLoadsRef = useRef(0);
  const [pendingLoads, setPendingLoads] = useState(0);
  const countPendingLoads = (loads: number) => {
    pendingLoadsRef.current = loads;
    setPendingLoads(loads);
  };
  const key = homeKey(emailAccountId);
  const { cache, mutate: mutateKey, fetcher } = useSWRConfig();
  useSavedHomeSeed(emailAccountId);
  const home = useSWR<TodayHomeData>(key, loadHome(cache, fetcher), {
    // A row action while a load is on its way makes SWR drop that load's
    // answer; ask again so the fresh lanes still arrive. A newer load still
    // running will answer instead: asking again then would replace it, and
    // that one would be dropped in turn, without end.
    onDiscarded: (discarded) => {
      if (key && !cache.get(discarded)?.isValidating) mutateKey(key);
    },
    // Each load spends Gmail quota, so tab switches share one.
    focusThrottleInterval: FOCUS_REFRESH_MIN_MS,
    onSuccess: (data) =>
      countPendingLoads(isRefreshing(data) ? pendingLoadsRef.current + 1 : 0),
    refreshInterval: (data) =>
      data && isRefreshing(data) && pendingLoadsRef.current < PENDING_LOAD_LIMIT
        ? PENDING_REFRESH_MS
        : 0,
  });
  const { mutate } = home;

  useEffect(() => {
    if (!home.data || seededCopies.has(home.data) || !emailAccountId) return;
    writeCachedToday({
      emailAccountId,
      timeZone: browserTimeZone(),
      data: home.data,
    });
  }, [home.data, emailAccountId]);

  // Cue sorted new mail or the user's reply changed a lane: show it now
  // rather than on the next reload. A backlog sorts a message every second
  // or so and each load spends Gmail quota, so after a load, changes wait
  // for the window to end and share one more.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let changedSinceLoad = false;
    const load = () => {
      changedSinceLoad = false;
      mutate();
      timer = setTimeout(() => {
        timer = undefined;
        if (changedSinceLoad) load();
      }, CHANGE_REFRESH_MIN_MS);
    };
    const stop = onTodayChanged((changedAccountId) => {
      // Each load spends the account's quota; another account's change is its own.
      if (changedAccountId && changedAccountId !== emailAccountId) return;
      if (timer) changedSinceLoad = true;
      else load();
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [emailAccountId, mutate]);

  return {
    data: home.data,
    error: home.error,
    // A cached Today shows while the fresh one loads.
    isLoading: home.isLoading && !home.data,
    mutate,
    gaveUp: Boolean(
      home.data &&
        isRefreshing(home.data) &&
        pendingLoads >= PENDING_LOAD_LIMIT,
    ),
    retry: () => {
      countPendingLoads(0);
      mutate();
    },
  };
}

/**
 * Starts loading Today once `enabled`, as when the pointer reaches its link,
 * so the page opens on data that is already on its way or here. Loaded data
 * is left as it is: Today refreshes it when it opens.
 */
export function useWarmHome(
  emailAccountId: string | null | undefined,
  enabled: boolean,
) {
  const key = enabled ? homeKey(emailAccountId) : null;
  const { cache, mutate, fetcher } = useSWRConfig();
  // With a saved copy, the hover puts it in place instead of loading: a
  // load on its way when Today opened would be dropped as overtaken by the
  // copy, and Today loads once itself.
  useSavedHomeSeed(enabled ? emailAccountId : null);
  useSWR<TodayHomeData>(key, loadHome(cache, fetcher), {
    revalidateIfStale: false,
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    // Today, opened meanwhile, may change a row before this load answers.
    // As in useHome, only when no newer load is running.
    onDiscarded: (discarded) => {
      if (key && !cache.get(discarded)?.isValidating) mutate(key);
    },
  });
}

/**
 * Work due soon in the user's connected apps, for Today's Next up. It loads
 * beside Today, not inside it: an app can take seconds to answer, and Today
 * shows without it. Kept in memory only, never in Today's saved copy, so a
 * finished task doesn't come back from an earlier visit.
 */
export function useHomeDeadlines(emailAccountId?: string | null) {
  const { data } = useSWR<GetHomeDeadlinesResponse>(
    emailAccountId
      ? getAccountScopedKey(
          `/api/user/home/deadlines?tz=${encodeURIComponent(browserTimeZone())}`,
          emailAccountId,
        )
      : null,
    // Each load asks every connected app, so tab switches share one, and a
    // failed load waits for the next visit rather than asking them again.
    { focusThrottleInterval: FOCUS_REFRESH_MIN_MS, shouldRetryOnError: false },
  );
  return data?.items;
}

/**
 * Puts Today's saved copy in SWR's own cache when it holds nothing for the
 * account, so row actions change what is on screen. Call it before the
 * hook's useSWR: effects run in order, so the copy is in place before SWR
 * starts its first load in the same commit, and that load isn't dropped as
 * overtaken by it. Effects only run in the browser after hydration, so the
 * server's render still matches.
 */
function useSavedHomeSeed(emailAccountId: string | null | undefined) {
  const key = homeKey(emailAccountId);
  const serializedKey = key ? unstable_serialize(key) : null;
  const { cache, mutate } = useSWRConfig();
  useLayoutEffect(() => {
    if (!serializedKey || !emailAccountId) return;
    if (cache.get(serializedKey)?.data !== undefined) return;
    // The zone the server is asked to count "today" in, as homeKey sends it.
    const saved = readCachedToday({
      emailAccountId,
      timeZone: browserTimeZone(),
    });
    if (!saved) return;
    seededCopies.add(saved);
    mutate(serializedKey, saved, { revalidate: false });
  }, [serializedKey, emailAccountId, cache, mutate]);
}

/** The app's fetcher, keeping what Today shows of each lane still loading. */
function loadHome(cache: Cache, fetcher: BareFetcher | undefined) {
  return async (
    key: NonNullable<ReturnType<typeof homeKey>>,
  ): Promise<TodayHomeData> => {
    if (!fetcher) throw new Error("No SWR fetcher configured");
    const fresh = (await fetcher(key)) as TodayHomeData;
    // Read once it answers, so changes made meanwhile are what is kept.
    const shown = cache.get(unstable_serialize(key))?.data as
      | TodayHomeData
      | undefined;
    return keepShownLanes(shown, fresh);
  };
}

/** Lanes still to load, whether shown as placeholders or as kept rows. */
function isRefreshing(data: TodayHomeData) {
  return Boolean(data.pending?.length || data.stale?.length);
}

function homeKey(emailAccountId: string | null | undefined) {
  return emailAccountId
    ? getAccountScopedKey(
        `/api/user/home?tz=${encodeURIComponent(browserTimeZone())}`,
        emailAccountId,
      )
    : null;
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
