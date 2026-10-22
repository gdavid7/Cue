"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { startMatchingBulkActionAction } from "@/utils/actions/mail-bulk-matching";
import type {
  MatchingBulkAction,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import type { GetMatchingCountResponse } from "@/app/api/user/mail/matching-count/route";
import { getActionErrorMessage } from "@/utils/error";
import { swrFetcher } from "@/providers/swr-fetcher";
import { followMatchingJobs } from "@/utils/mail-bulk/follow-matching-jobs";

type MatchingAccount = { id: string; scope: MatchingScope };

/**
 * Gmail's "select all conversations that match": once every row on the page
 * is selected, offers every conversation in the view, and runs a bulk action
 * over them as a server job per account, with progress and, where the action
 * is reversible, undo.
 */
export function useSelectAllMatching({
  accounts,
  viewIdentity,
  selection,
  allPageSelected,
  hasMore,
  onFinished,
}: {
  /** One per account the view spans; null when the view can't be listed in full. */
  accounts: MatchingAccount[] | null;
  viewIdentity: string;
  /** The page selection, by identity: changing it ends a select-all. */
  selection: ReadonlySet<string>;
  allPageSelected: boolean;
  hasMore: boolean;
  onFinished: () => void;
}) {
  const [selected, setSelected] = useState<{
    viewIdentity: string;
    selection: ReadonlySet<string>;
  } | null>(null);
  const showBanner = Boolean(accounts?.length) && allPageSelected && hasMore;
  const active =
    showBanner &&
    selected?.viewIdentity === viewIdentity &&
    selected.selection === selection;

  const { data: total = null } = useSWR(
    showBanner && accounts ? ["mail-matching-count", viewIdentity] : null,
    () => countMatching(accounts ?? []),
    { revalidateOnFocus: false },
  );

  const select = useCallback(
    () => setSelected({ viewIdentity, selection }),
    [selection, viewIdentity],
  );
  const clear = useCallback(() => setSelected(null), []);

  const run = useCallback(
    async (action: MatchingBulkAction, options?: { labelId?: string }) => {
      if (!accounts?.length) return;
      setSelected(null);
      const started = await Promise.all(
        accounts.map(
          async (
            account,
          ): Promise<{ accountId: string; jobId: string } | null> => {
            const result = await startMatchingBulkActionAction(account.id, {
              scope: account.scope,
              action,
              labelId: options?.labelId,
            });
            const jobId = result?.data?.jobId;
            if (!jobId) {
              toast.error(getActionErrorMessage(result ?? {}));
              return null;
            }
            return { accountId: account.id, jobId };
          },
        ),
      );
      const jobs = started.filter(
        (job): job is { accountId: string; jobId: string } => Boolean(job),
      );
      if (!jobs.length) return;
      await followMatchingJobs({ jobs, action, onFinished });
    },
    [accounts, onFinished],
  );

  return { showBanner, active, total, select, clear, run };
}

async function countMatching(accounts: MatchingAccount[]) {
  const counts = await Promise.all(
    accounts.map(
      (account) =>
        swrFetcher(
          `/api/user/mail/matching-count?scope=${encodeURIComponent(JSON.stringify(account.scope))}`,
          undefined,
          account.id,
        ) as Promise<GetMatchingCountResponse>,
    ),
  );
  if (counts.some((result) => result.count === null)) return null;
  return counts.reduce((sum, result) => sum + (result.count ?? 0), 0);
}
