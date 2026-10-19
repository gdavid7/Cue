import { useEffect, useLayoutEffect, useRef, useState } from "react";
import useSWR, { unstable_serialize, useSWRConfig } from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
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
const seededCopies = new WeakSet<GetHomeResponse>();

/**
 * Today's data. It opens on what Today last showed in this browser, then
 * refreshes. `gaveUp` is set once a lane has stayed pending through every
 * refresh; `retry` asks again from the start.
 */
export function useHome(emailAccountId?: string | null, userId?: string) {
  // Loads in a row that came back with a lane still pending. SWR may call
  // refreshInterval from an earlier render, so it reads the ref.
  const pendingLoadsRef = useRef(0);
  const [pendingLoads, setPendingLoads] = useState(0);
  const countPendingLoads = (loads: number) => {
    pendingLoadsRef.current = loads;
    setPendingLoads(loads);
  };
  const key = homeKey(emailAccountId);
  const { cache, mutate: mutateKey } = useSWRConfig();
  useSavedHomeSeed(emailAccountId, userId);
  const home = useSWR<GetHomeResponse>(key, {
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
      countPendingLoads(data.pending.length ? pendingLoadsRef.current + 1 : 0),
    refreshInterval: (data) =>
      data?.pending.length && pendingLoadsRef.current < PENDING_LOAD_LIMIT
        ? PENDING_REFRESH_MS
        : 0,
  });
  const { mutate } = home;

  useEffect(() => {
    if (!home.data || seededCopies.has(home.data) || !emailAccountId || !userId)
      return;
    writeCachedToday({ userId, emailAccountId, data: home.data });
  }, [home.data, emailAccountId, userId]);

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
      home.data?.pending.length && pendingLoads >= PENDING_LOAD_LIMIT,
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
  userId?: string,
) {
  const key = enabled ? homeKey(emailAccountId) : null;
  const { cache, mutate } = useSWRConfig();
  // With a saved copy, the hover puts it in place instead of loading: a
  // load on its way when Today opened would be dropped as overtaken by the
  // copy, and Today loads once itself.
  useSavedHomeSeed(enabled ? emailAccountId : null, userId);
  useSWR<GetHomeResponse>(key, {
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
function useSavedHomeSeed(
  emailAccountId: string | null | undefined,
  userId: string | undefined,
) {
  const key = homeKey(emailAccountId);
  const serializedKey = key ? unstable_serialize(key) : null;
  const { cache, mutate } = useSWRConfig();
  useLayoutEffect(() => {
    if (!serializedKey || !emailAccountId || !userId) return;
    if (cache.get(serializedKey)?.data !== undefined) return;
    const saved = readCachedToday({ userId, emailAccountId });
    if (!saved) return;
    seededCopies.add(saved);
    mutate(serializedKey, saved, { revalidate: false });
  }, [serializedKey, emailAccountId, userId, cache, mutate]);
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
