import useSWR from "swr";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { getAccountScopedKey } from "@/utils/swr";

export function useHome(emailAccountId?: string | null) {
  return useSWR<GetHomeResponse>(
    emailAccountId
      ? getAccountScopedKey("/api/user/home", emailAccountId)
      : null,
    { revalidateOnFocus: false },
  );
}
