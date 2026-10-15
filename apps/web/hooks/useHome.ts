import useSWR from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { getAccountScopedKey } from "@/utils/swr";

export function useHome(emailAccountId?: string | null) {
  return useSWR<GetHomeResponse>(
    emailAccountId
      ? getAccountScopedKey(
          `/api/user/home?tz=${encodeURIComponent(browserTimeZone())}`,
          emailAccountId,
        )
      : null,
    { revalidateOnFocus: false },
  );
}

function browserTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}
