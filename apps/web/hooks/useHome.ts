import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { onTodayChanged } from "@/utils/home/today-changes";
import { getAccountScopedKey } from "@/utils/swr";

// A lane Gmail couldn't serve in time loads on a later request. A minute of
// asking is enough: past that the account's Gmail is busy for longer, and
// each ask spends its quota again.
const PENDING_REFRESH_MS = 5000;
const PENDING_LOAD_LIMIT = 12;
const FOCUS_REFRESH_MIN_MS = 30_000;
const CHANGE_COALESCE_MS = 3000;

/**
 * Today's data. `gaveUp` is set once a lane has stayed pending through every
 * refresh; `retry` asks again from the start.
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
  const home = useSWR<GetHomeResponse>(
    emailAccountId
      ? getAccountScopedKey(
          `/api/user/home?tz=${encodeURIComponent(browserTimeZone())}`,
          emailAccountId,
        )
      : null,
    {
      // Each load spends Gmail quota, so tab switches share one.
      focusThrottleInterval: FOCUS_REFRESH_MIN_MS,
      onSuccess: (data) =>
        countPendingLoads(
          data.pending.length ? pendingLoadsRef.current + 1 : 0,
        ),
      refreshInterval: (data) =>
        data?.pending.length && pendingLoadsRef.current < PENDING_LOAD_LIMIT
          ? PENDING_REFRESH_MS
          : 0,
    },
  );
  const { mutate } = home;

  // Cue sorted new mail or the user's reply changed a lane: show it now
  // rather than on the next reload. A backlog sorts several messages a
  // second, and each load spends Gmail quota, so a burst shares one load.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = onTodayChanged(() => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        mutate();
      }, CHANGE_COALESCE_MS);
    });
    return () => {
      stop();
      clearTimeout(timer);
    };
  }, [mutate]);

  return {
    data: home.data,
    error: home.error,
    isLoading: home.isLoading,
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

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
