import useSWR from "swr";
import type { GetExecutedRulesResponse } from "@/app/api/user/executed-rules/history/route";
import type { HistoryAction } from "@/utils/rule/history-action-kinds";

export type HistoryFilters = {
  action: HistoryAction | null;
  /** ISO times: the window Today's "While you were away" counted. */
  since: string | null;
  until: string | null;
  /** Only what Cue did on its own, not what the user applied through it. */
  automatedOnly: boolean;
};

export function useExecutedRules({
  page,
  ruleId,
  threadId,
  excludeMessageId,
  filters,
}: {
  page: number;
  ruleId: string;
  threadId?: string;
  excludeMessageId?: string;
  filters?: HistoryFilters;
}) {
  const params = new URLSearchParams({ page: String(page), ruleId });
  if (filters?.action) params.set("action", filters.action);
  if (filters?.since) params.set("since", filters.since);
  if (filters?.until) params.set("until", filters.until);
  if (filters?.automatedOnly) params.set("automated", "1");
  if (threadId) params.set("threadId", threadId);
  if (excludeMessageId) params.set("excludeMessageId", excludeMessageId);
  return useSWR<GetExecutedRulesResponse>(
    `/api/user/executed-rules/history?${params}`,
  );
}
