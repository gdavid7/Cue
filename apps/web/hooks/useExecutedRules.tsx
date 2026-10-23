import useSWR from "swr";
import type { GetExecutedRulesResponse } from "@/app/api/user/executed-rules/history/route";
import type { HistoryAction } from "@/utils/rule/history-actions";

export function useExecutedRules({
  page,
  ruleId,
  threadId,
  excludeMessageId,
  action,
}: {
  page: number;
  ruleId: string;
  threadId?: string;
  excludeMessageId?: string;
  action?: HistoryAction | null;
}) {
  const params = new URLSearchParams({ page: String(page), ruleId });
  if (action) params.set("action", action);
  if (threadId) params.set("threadId", threadId);
  if (excludeMessageId) params.set("excludeMessageId", excludeMessageId);
  return useSWR<GetExecutedRulesResponse>(
    `/api/user/executed-rules/history?${params}`,
  );
}
