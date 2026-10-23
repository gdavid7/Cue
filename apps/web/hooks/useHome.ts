import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useSyncExternalStore,
} from "react";
import useSWR, {
  type Cache,
  type BareFetcher,
  unstable_serialize,
  useSWRConfig,
} from "swr";
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
// The first loads of a lane still pending are part of opening Today; after
// those, Today is waiting on Gmail by itself and asks behind people's work.
const REQUESTED_PENDING_LOADS = 2;
// Loads further apart than this aren't one streak of asking.
const STREAK_GAP_MS = PENDING_REFRESH_MS * 3;
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
  const key = homeKey(emailAccountId);
  const serializedKey = key ? unstable_serialize(key) : null;
  const { cache, mutate: mutateKey, fetcher } = useSWRConfig();
  useSavedHomeSeed(emailAccountId);
  // Loads in a row that left a lane pending count from when Today opens: a
  // warm-up from a hover just before is part of that, while what an
  // earlier visit, or another account, left isn't.
  const shownKeyRef = useRef<string | null>(null);
  useLayoutEffect(() => {
    const switched = shownKeyRef.current !== null;
    shownKeyRef.current = serializedKey;
    if (!serializedKey) return;
    if (switched || pendingStreaks.idleFor(serializedKey) > STREAK_GAP_MS)
      pendingStreaks.reset(serializedKey);
  }, [serializedKey]);
  const pendingLoads = useSyncExternalStore(
    pendingStreaks.subscribe,
    () => (serializedKey ? pendingStreaks.get(serializedKey) : 0),
    () => 0,
  );
  // Today's own loads on their way (see `load`).
  const ownLoadsRef = useRef(0);
  const home = useSWR<TodayHomeData>(key, loadHome(cache, fetcher), {
    // A row action while a load is on its way makes SWR drop that load's
    // answer; ask again so the fresh lanes still arrive. A newer load still
    // running will answer instead: asking again then would replace it, and
    // that one would be dropped in turn, without end.
    onDiscarded: (discarded) => {
      if (ownLoadsRef.current > 0) return;
      if (key && !cache.get(discarded)?.isValidating) mutateKey(key);
    },
    // Each load spends Gmail quota, so tab switches share one.
    focusThrottleInterval: FOCUS_REFRESH_MIN_MS,
  });
  const { mutate } = home;
  // Loads Today starts itself go straight into the cache rather than through
  // SWR's revalidation, which runs whichever hook on the key subscribed
  // first (the sidebar's warm-up, after a hover) with that hook's fetcher:
  // so each says for itself whether anyone asked for it.
  const load = useCallback(
    ({ requested }: { requested: boolean }) => {
      if (!key) return;
      ownLoadsRef.current++;
      mutate(loadHome(cache, fetcher, { requested })(key), {
        revalidate: false,
      })
        .catch(() => undefined)
        .finally(() => {
          ownLoadsRef.current--;
        });
    },
    [key, cache, fetcher, mutate],
  );

  // A lane Gmail couldn't serve in time is asked for again shortly.
  const refreshing = Boolean(home.data && isRefreshing(home.data));
  useEffect(() => {
    if (!refreshing || pendingLoads === 0 || pendingLoads >= PENDING_LOAD_LIMIT)
      return;
    const timer = setTimeout(
      () => load({ requested: pendingLoads < REQUESTED_PENDING_LOADS }),
      PENDING_REFRESH_MS,
    );
    return () => clearTimeout(timer);
  }, [refreshing, pendingLoads, load]);

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
    const loadChange = () => {
      changedSinceLoad = false;
      load({ requested: false });
      timer = setTimeout(() => {
        timer = undefined;
        if (changedSinceLoad) loadChange();
      }, CHANGE_REFRESH_MIN_MS);
    };
    const stop = onTodayChanged((changedAccountId) => {
      // Each load spends the account's quota; another account's change is its own.
      if (changedAccountId && changedAccountId !== emailAccountId) return;
      if (timer) changedSinceLoad = true;
      else loadChange();
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [emailAccountId, load]);

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
      if (serializedKey) pendingStreaks.reset(serializedKey);
      load({ requested: true });
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

/**
 * The app's fetcher, keeping what Today shows of each lane still loading, and
 * counting loads in a row that left a lane pending, whichever hook ran them.
 * A load nobody asked for says so, and the server then reads Gmail behind
 * what people are doing rather than ahead of it.
 */
function loadHome(
  cache: Cache,
  fetcher: BareFetcher | undefined,
  { requested }: { requested: boolean } = { requested: true },
) {
  return async (
    key: NonNullable<ReturnType<typeof homeKey>>,
  ): Promise<TodayHomeData> => {
    if (!fetcher) throw new Error("No SWR fetcher configured");
    const [path, accountId] = key;
    const serializedKey = unstable_serialize(key);
    let fresh: TodayHomeData;
    try {
      fresh = (await fetcher(
        requested ? key : [`${path}&refresh=auto`, accountId],
      )) as TodayHomeData;
    } catch (error) {
      // A failed ask counts towards giving up, as one that came back pending.
      pendingStreaks.record(serializedKey, true);
      throw error;
    }
    // Read once it answers, so changes made meanwhile are what is kept.
    const shown = cache.get(serializedKey)?.data as TodayHomeData | undefined;
    const data = keepShownLanes(shown, fresh);
    pendingStreaks.record(serializedKey, isRefreshing(data));
    return data;
  };
}

/**
 * By SWR key, how many loads in a row came back with a lane still pending.
 * Kept outside any one hook, as the sidebar's warm-up and Today share loads.
 */
const pendingStreaks = (() => {
  const streaks = new Map<string, number>();
  const lastLoadAt = new Map<string, number>();
  const listeners = new Set<() => void>();
  const set = (key: string, value: number) => {
    if ((streaks.get(key) ?? 0) === value) return;
    streaks.set(key, value);
    for (const listener of listeners) listener();
  };
  return {
    get: (key: string) => streaks.get(key) ?? 0,
    /** How long since a load of `key` last answered. */
    idleFor: (key: string) => Date.now() - (lastLoadAt.get(key) ?? 0),
    record: (key: string, refreshing: boolean) => {
      lastLoadAt.set(key, Date.now());
      set(key, refreshing ? (streaks.get(key) ?? 0) + 1 : 0);
    },
    reset: (key: string) => set(key, 0),
    clear: () => {
      streaks.clear();
      lastLoadAt.clear();
    },
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
})();

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

export function resetPendingStreaksForTesting() {
  pendingStreaks.clear();
}
