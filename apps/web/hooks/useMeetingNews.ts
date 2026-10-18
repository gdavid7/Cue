import useSWR from "swr";
import type { GetMeetingNewsResponse } from "@/app/api/user/meeting-news/route";
import { fetchForAccounts } from "@/utils/fetch-for-accounts";
import { mergeMeetingNews } from "@/utils/home/merge-home";
import { getAccountScopedKey } from "@/utils/swr";

const MEETING_NEWS_PATH = "/api/user/meeting-news";

export function useMeetingNews(emailAccountId?: string | null) {
  return useSWR<GetMeetingNewsResponse>(
    emailAccountId
      ? getAccountScopedKey(MEETING_NEWS_PATH, emailAccountId)
      : null,
    { revalidateOnFocus: false },
  );
}

/**
 * Meeting news from every account's calendars, each organization once. One
 * account that fails only leaves its meetings out, since this is extra.
 */
export function useAllAccountsMeetingNews(accountIds: string[] | null) {
  return useSWR<GetMeetingNewsResponse>(
    accountIds?.length
      ? [MEETING_NEWS_PATH, "all-accounts", ...accountIds]
      : null,
    async () => {
      const { byAccount } = await fetchForAccounts<GetMeetingNewsResponse>(
        MEETING_NEWS_PATH,
        accountIds ?? [],
      );
      return {
        meetings: mergeMeetingNews(byAccount.map(({ data }) => data.meetings)),
      };
    },
    { revalidateOnFocus: false },
  );
}
