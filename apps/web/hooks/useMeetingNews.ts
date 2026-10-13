import useSWR from "swr";
import type { GetMeetingNewsResponse } from "@/app/api/user/meeting-news/route";
import { getAccountScopedKey } from "@/utils/swr";

export function useMeetingNews(emailAccountId?: string | null) {
  return useSWR<GetMeetingNewsResponse>(
    emailAccountId
      ? getAccountScopedKey("/api/user/meeting-news", emailAccountId)
      : null,
    { revalidateOnFocus: false },
  );
}
