import { useRef } from "react";
import useSWR from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { getAccountScopedKey } from "@/utils/swr";

// A lane Gmail couldn't serve in time loads on a later request. A minute of
// asking is enough: past that the account's Gmail is busy for longer, and
// each ask spends its quota again.
const PENDING_REFRESH_MS = 5000;
const PENDING_REFRESH_LIMIT = 12;

export function useHome(emailAccountId?: string | null) {
  const pendingRefreshes = useRef(0);
  return useSWR<GetHomeResponse>(
    emailAccountId
      ? getAccountScopedKey(
          `/api/user/home?tz=${encodeURIComponent(browserTimeZone())}`,
          emailAccountId,
        )
      : null,
    {
      revalidateOnFocus: false,
      onSuccess: (data) => {
        pendingRefreshes.current = data.pending.length
          ? pendingRefreshes.current + 1
          : 0;
      },
      refreshInterval: (data) =>
        data?.pending.length &&
        pendingRefreshes.current <= PENDING_REFRESH_LIMIT
          ? PENDING_REFRESH_MS
          : 0,
    },
  );
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
