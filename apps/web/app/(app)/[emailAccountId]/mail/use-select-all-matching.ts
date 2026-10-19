"use client";

import { useCallback, useState } from "react";
import useSWR from "swr";
import { toast } from "sonner";
import { toastUndo } from "@/components/Toast";
import {
  cancelMatchingBulkActionAction,
  startMatchingBulkActionAction,
  undoMatchingBulkActionAction,
} from "@/utils/actions/mail-bulk-matching";
import type {
  MatchingBulkAction,
  MatchingScope,
} from "@/utils/actions/mail-bulk-matching.validation";
import type { GetMailBulkJobResponse } from "@/app/api/user/mail/bulk-jobs/[jobId]/route";
import type { GetMatchingCountResponse } from "@/app/api/user/mail/matching-count/route";
import { getActionErrorMessage } from "@/utils/error";
import { swrFetcher } from "@/providers/swr-fetcher";
import { sleep } from "@/utils/sleep";
import {
  getMatchingProgressCopy,
  getMatchingResultCopy,
  isUndoableMatchingAction,
} from "@/app/(app)/[emailAccountId]/mail/select-all-matching";

const POLL_INTERVAL_MS = 1500;
// A job that stops reporting is left to finish on its own; the toast stops
// waiting on it rather than spin for good.
const MAX_POLL_MS = 6 * 60 * 60 * 1000;
const MAX_FAILED_POLLS = 20;

type MatchingAccount = { id: string; scope: MatchingScope };
type RunningJob = { accountId: string; jobId: string };

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
        accounts.map(async (account): Promise<RunningJob | null> => {
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
        }),
      );
      const jobs = started.filter((job): job is RunningJob => Boolean(job));
      if (!jobs.length) return;
      await followJobs({ jobs, action, onFinished });
    },
    [accounts, onFinished],
  );

  return { showBanner, active, total, select, clear, run };
}

async function followJobs({
  jobs,
  action,
  onFinished,
}: {
  jobs: RunningJob[];
  action: MatchingBulkAction | "undo";
  onFinished: () => void;
}) {
  const toastId = `mail-bulk-${jobs[0]?.jobId}`;
  const stop = () => {
    for (const job of jobs)
      cancelMatchingBulkActionAction(job.accountId, { jobId: job.jobId }).catch(
        () => undefined,
      );
  };
  toast.loading(getMatchingProgressCopy(action), {
    id: toastId,
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Stop", onClick: stop },
  });

  const startedAt = Date.now();
  // The last state each job reported, kept through a failed poll.
  const states: (GetMailBulkJobResponse | null)[] = jobs.map(() => null);
  let failedPolls = 0;
  while (Date.now() - startedAt < MAX_POLL_MS) {
    await sleep(POLL_INTERVAL_MS);
    const polled = await Promise.all(jobs.map(readJob));
    polled.forEach((state, index) => {
      if (state) states[index] = state;
    });
    failedPolls = polled.some((state) => !state) ? failedPolls + 1 : 0;
    if (failedPolls >= MAX_FAILED_POLLS) break;
    if (states.every((state) => state && isFinished(state.status))) break;
    const progress = progressPercent(states);
    toast.loading(getMatchingProgressCopy(action), {
      id: toastId,
      description: progress === null ? undefined : `${progress}% done`,
      duration: Number.POSITIVE_INFINITY,
      action: { label: "Stop", onClick: stop },
    });
  }
  onFinished();

  const known = states.filter((state): state is GetMailBulkJobResponse =>
    Boolean(state),
  );
  const conversations = known.reduce(
    (sum, state) => sum + state.conversations,
    0,
  );
  const failed = known.reduce((sum, state) => sum + state.failed, 0);
  const anyFailed = known.some((state) => state.status === "failed");
  const capped = known.some((state) => state.capped);
  const cancelled = known.some((state) => state.status === "cancelled");

  const unfinished = states.some(
    (state) => !state || !isFinished(state.status),
  );
  if (unfinished) {
    toast.message("Still working on it", {
      id: toastId,
      description: "It carries on in the background; you can leave this page.",
      duration: 8000,
    });
    return;
  }
  if (anyFailed) {
    toast.error("Couldn't finish that for every conversation", {
      id: toastId,
      description: "Some may have changed. Try again to finish the rest.",
      duration: 10_000,
    });
    return;
  }

  const message = cancelled
    ? "Stopped"
    : getMatchingResultCopy(action, conversations);
  const description = [
    failed
      ? `${failed.toLocaleString("en-US")} messages couldn't be changed.`
      : "",
    capped
      ? "That's as many as one action covers; run it again for the rest."
      : "",
  ]
    .filter(Boolean)
    .join(" ");

  if (action !== "undo" && isUndoableMatchingAction(action)) {
    toastUndo({
      id: toastId,
      message,
      duration: 10_000,
      onUndo: () => undoJobs({ jobs, onFinished }),
    });
    if (description) toast.message(description);
    return;
  }
  toast.success(message, {
    id: toastId,
    description: description || undefined,
    duration: 6000,
  });
}

async function undoJobs({
  jobs,
  onFinished,
}: {
  jobs: RunningJob[];
  onFinished: () => void;
}) {
  const started = await Promise.all(
    jobs.map(async (job): Promise<RunningJob | null> => {
      const result = await undoMatchingBulkActionAction(job.accountId, {
        jobId: job.jobId,
      });
      const jobId = result?.data?.jobId;
      if (!jobId) {
        toast.error(getActionErrorMessage(result ?? {}));
        return null;
      }
      return { accountId: job.accountId, jobId };
    }),
  );
  const undoing = started.filter((job): job is RunningJob => Boolean(job));
  if (undoing.length)
    await followJobs({ jobs: undoing, action: "undo", onFinished });
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

async function readJob(job: RunningJob) {
  try {
    return (await swrFetcher(
      `/api/user/mail/bulk-jobs/${job.jobId}`,
      undefined,
      job.accountId,
    )) as GetMailBulkJobResponse;
  } catch {
    return null;
  }
}

function progressPercent(states: (GetMailBulkJobResponse | null)[]) {
  const known = states.filter((state): state is GetMailBulkJobResponse =>
    Boolean(state),
  );
  // Still listing: the total isn't known yet.
  if (!known.length || known.some((state) => state.status === "listing"))
    return null;
  const total = known.reduce((sum, state) => sum + state.total, 0);
  if (!total) return null;
  const applied = known.reduce((sum, state) => sum + state.applied, 0);
  return Math.min(99, Math.floor((applied / total) * 100));
}

function isFinished(status: GetMailBulkJobResponse["status"]) {
  return status === "done" || status === "cancelled" || status === "failed";
}
