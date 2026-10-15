import { useRef, useState } from "react";
import useSWR from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { getAccountScopedKey } from "@/utils/swr";

// A lane Gmail couldn't serve in time loads on a later request. A minute of
// asking is enough: past that the account's Gmail is busy for longer, and
// each ask spends its quota again.
const PENDING_REFRESH_MS = 5000;
const PENDING_LOAD_LIMIT = 12;

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
      revalidateOnFocus: false,
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
