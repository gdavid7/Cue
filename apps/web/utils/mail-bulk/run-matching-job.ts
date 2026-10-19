import uniq from "lodash/uniq";
import { z } from "zod";
import {
  type MatchingFilter,
  matchingScopeSchema,
} from "@/utils/actions/mail-bulk-matching.validation";
import { mapWithConcurrency } from "@/utils/async";
import type { EmailProvider } from "@/utils/email/types";
import { isInvalidGrantError } from "@/utils/error";
import { resumeAfterGmailDeferral } from "@/utils/gmail/deferred-resume";
import {
  getGmailCallDeferredError,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import {
  ACTIVE_MAIL_BULK_JOB_STATUSES,
  isActiveMailBulkJob,
  isStaleMailBulkJob,
  type MailBulkJobAction,
  type MailBulkJobState,
  type MailBulkTarget,
  mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";
import { sleep } from "@/utils/sleep";
import { hasDurableQstash, publishToQstash } from "@/utils/upstash";

export const MAIL_BULK_JOB_PATH = "/api/mail/bulk-matching";
export const MAIL_BULK_JOB_CALLER = "mail/bulk-matching";

// With QStash, each delivery stops well inside the route's five minutes and
// hands the rest to the next one. Without it nothing delivers the rest
// reliably, so one delivery does the whole job, using most of its time.
const DURABLE_STEP_BUDGET_MS = 200_000;
const SINGLE_DELIVERY_BUDGET_MS = 270_000;
// One Gmail batchModify takes up to 1000 ids; half keeps a failed chunk small.
const APPLY_CHUNK_SIZE = 500;
const PER_ITEM_CONCURRENCY = 2;
// A job's targets live in Redis until it expires; this bounds that list.
const MAX_JOB_TARGETS = 100_000;
// What one delivery gets through at background priority: Gmail's batch calls
// cover many messages each, while per-conversation or per-message calls, and
// every Outlook call, take one request per item.
const SINGLE_DELIVERY_BATCH_TARGETS = 10_000;
const SINGLE_DELIVERY_PER_ITEM_TARGETS = 1000;
// An undo waits for the job it reverses to stop, checking this often.
const SOURCE_WAIT_MS = 2000;

export const mailBulkJobBody = z.object({
  jobId: z.string().uuid(),
  emailAccountId: z.string().min(1),
  /** The view being listed. Only carried while the job is still listing. */
  scope: matchingScopeSchema.optional(),
  /** The page the listing reads next. */
  pageToken: z.string().optional(),
  deferrals: z.number().int().nonnegative(),
});
export type MailBulkJobBody = z.infer<typeof mailBulkJobBody>;

type StepResult =
  | MailBulkJobState["status"]
  | "continued"
  | "deferred"
  | "missing";

/**
 * Runs one delivery of a bulk job: lists the view's messages into the job's
 * targets, then applies the action to them in chunks. Every Gmail call runs at
 * background priority, so the quota gate only spends capacity nobody is using.
 * When it defers a call, a durable scheduler resumes the job later; without
 * one, the delivery waits the deferral out while it has time.
 */
export async function runMailBulkJobStep({
  body,
  provider,
  ownerEmail,
  logger,
  store = mailBulkJobStore,
  durable = hasDurableQstash(),
  budgetMs,
  maxTargets,
  now = Date.now,
  wait = sleep,
}: {
  body: MailBulkJobBody;
  provider: EmailProvider;
  ownerEmail: string;
  logger: Logger;
  store?: typeof mailBulkJobStore;
  /** Whether a scheduler can deliver the rest of the job later. */
  durable?: boolean;
  budgetMs?: number;
  maxTargets?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}): Promise<StepResult> {
  const job = await store.get(body.jobId);
  if (!job || job.emailAccountId !== body.emailAccountId) return "missing";
  if (!isActiveMailBulkJob(job.status)) return job.status;

  const deadline =
    now() +
    (budgetMs ??
      (durable ? DURABLE_STEP_BUDGET_MS : SINGLE_DELIVERY_BUDGET_MS));
  const outOfTime = () => now() >= deadline;
  const targetCap =
    maxTargets ??
    (durable ? MAX_JOB_TARGETS : singleDeliveryTargetCap(job.action, provider));
  let pageToken = body.pageToken;

  const runPhases = async (): Promise<StepResult> => {
    const current = await store.get(body.jobId);
    if (!current) return "missing";
    if (current.status === "listing") {
      if (!body.scope) {
        await store.transition(body.jobId, ["listing"], "failed");
        return "failed";
      }
      let total = current.total;
      do {
        const page = await provider.listMatchingMessages({
          scope: body.scope,
          only: filterForAction(job.action),
          pageToken,
        });
        const targets = page.messages
          .slice(0, Math.max(0, targetCap - total))
          .map((message) => ({
            messageId: message.id,
            threadId: message.threadId,
          }));
        const conversations = await store.appendTargets(body.jobId, targets);
        await store.increment(body.jobId, "total", targets.length);
        await store.increment(body.jobId, "conversations", conversations);
        total += targets.length;
        pageToken = page.nextPageToken;

        if (pageToken && total >= targetCap) {
          await store.setCapped(body.jobId);
          pageToken = undefined;
        }
        if (pageToken && outOfTime()) {
          await enqueueMailBulkJob({ ...body, pageToken, deferrals: 0 });
          return "continued";
        }
      } while (pageToken);
      // A Stop during listing leaves the job cancelled rather than applying.
      const moved = await store.transition(body.jobId, ["listing"], "applying");
      if (!moved) return (await store.get(body.jobId))?.status ?? "missing";
    }

    return applyTargets({
      jobId: body.jobId,
      job,
      provider,
      ownerEmail,
      store,
      logger,
      outOfTime,
      wait,
      continueLater: () =>
        enqueueMailBulkJob({
          jobId: body.jobId,
          emailAccountId: body.emailAccountId,
          deferrals: 0,
        }),
    });
  };

  while (true) {
    try {
      return await runWithGmailQuota(
        { caller: MAIL_BULK_JOB_CALLER, priority: "background" },
        runPhases,
      );
    } catch (error) {
      const deferred = getGmailCallDeferredError(error);
      // Nothing would resume the job later, so it waits here while it can.
      if (deferred && !durable && now() + deferred.retryAfterMs < deadline) {
        await wait(deferred.retryAfterMs);
        continue;
      }
      return failOrResume({
        error,
        body,
        pageToken,
        job,
        durable,
        store,
        logger,
      });
    }
  }
}

export async function enqueueMailBulkJob(body: MailBulkJobBody) {
  // One job per account at a time, so two of them never share its quota.
  await publishToQstash(MAIL_BULK_JOB_PATH, body, {
    key: `mail-bulk-${body.emailAccountId}`,
    parallelism: 1,
  });
}

async function failOrResume({
  error,
  body,
  pageToken,
  job,
  durable,
  store,
  logger,
}: {
  error: unknown;
  body: MailBulkJobBody;
  pageToken: string | undefined;
  job: MailBulkJobState;
  durable: boolean;
  store: typeof mailBulkJobStore;
  logger: Logger;
}): Promise<StepResult> {
  const deferred = getGmailCallDeferredError(error);
  if (deferred && durable) {
    const latest = await store.get(body.jobId);
    const resume = await resumeAfterGmailDeferral({
      error,
      path: MAIL_BULK_JOB_PATH,
      body: {
        ...body,
        ...(latest?.status === "listing"
          ? { pageToken }
          : { scope: undefined }),
      },
      deferrals: body.deferrals,
      jobKey: `mail-bulk-${body.jobId}-${latest?.total ?? 0}-${latest?.applied ?? 0}`,
      job: "a bulk mail action",
      logger,
    });
    if (resume === "scheduled") return "deferred";
  } else if (deferred) {
    logger.warn("Bulk mail action ran out of time waiting on Gmail quota", {
      action: job.action,
    });
  } else {
    logger.error("Bulk mail action failed", { error, action: job.action });
  }
  await store.transition(body.jobId, ACTIVE_MAIL_BULK_JOB_STATUSES, "failed");
  return "failed";
}

async function applyTargets({
  jobId,
  job,
  provider,
  ownerEmail,
  store,
  logger,
  outOfTime,
  wait,
  continueLater,
}: {
  jobId: string;
  job: MailBulkJobState;
  provider: EmailProvider;
  ownerEmail: string;
  store: typeof mailBulkJobStore;
  logger: Logger;
  outOfTime: () => boolean;
  wait: (ms: number) => Promise<unknown>;
  continueLater: () => Promise<void>;
}): Promise<StepResult> {
  // An undo reads what its source job listed only once that job has stopped,
  // so nothing the source changes afterwards is left unrestored.
  const targetsJobId = job.sourceJobId ?? jobId;
  let limit: number | undefined;
  if (job.sourceJobId) {
    while (true) {
      const source = await store.get(job.sourceJobId);
      if (
        !source ||
        !isActiveMailBulkJob(source.status) ||
        isStaleMailBulkJob(source)
      ) {
        limit = source?.applied ?? 0;
        break;
      }
      if (outOfTime()) {
        await continueLater();
        return "continued";
      }
      await wait(SOURCE_WAIT_MS);
    }
  }

  while (true) {
    const current = await store.get(jobId);
    if (!current) return "missing";
    if (current.status !== "applying") return current.status;

    const end = limit ?? current.total;
    const targets = await store.readTargets(
      targetsJobId,
      current.applied,
      Math.min(APPLY_CHUNK_SIZE, end - current.applied),
    );
    if (!targets.length) {
      const moved = await store.transition(jobId, ["applying"], "done");
      return moved ? "done" : ((await store.get(jobId))?.status ?? "missing");
    }

    const failed = await applyChunk({
      action: job.action,
      labelId: job.labelId,
      targets,
      provider,
      ownerEmail,
      logger,
    });
    await store.increment(jobId, "failed", failed);
    await store.increment(jobId, "applied", targets.length);

    if (outOfTime()) {
      await continueLater();
      return "continued";
    }
  }
}

/** Applies the action to one chunk; resolves how many targets failed. */
async function applyChunk({
  action,
  labelId,
  targets,
  provider,
  ownerEmail,
  logger,
}: {
  action: MailBulkJobAction;
  labelId?: string;
  targets: MailBulkTarget[];
  provider: EmailProvider;
  ownerEmail: string;
  logger: Logger;
}): Promise<number> {
  const messageIds = targets.map((target) => target.messageId);
  const threadIds = uniq(targets.map((target) => target.threadId));

  const wholeChunk = async (run: () => Promise<unknown>) => {
    try {
      await run();
      return 0;
    } catch (error) {
      if (shouldStopJob(error)) throw error;
      logger.warn("Bulk mail action chunk failed", { error, action });
      return targets.length;
    }
  };
  // A failed conversation counts all of its messages.
  const eachThread = async (run: (threadId: string) => Promise<unknown>) => {
    const results = await mapWithConcurrency(
      threadIds,
      PER_ITEM_CONCURRENCY,
      async (threadId) => {
        try {
          await run(threadId);
          return 0;
        } catch (error) {
          if (shouldStopJob(error)) throw error;
          return targets.filter((target) => target.threadId === threadId)
            .length;
        }
      },
    );
    const failed = results.reduce<number>((sum, count) => sum + count, 0);
    if (failed)
      logger.warn("Bulk mail action items failed", { failed, action });
    return failed;
  };

  switch (action) {
    case "archive":
      return wholeChunk(() => provider.archiveMessages(messageIds));
    case "unarchive":
      return wholeChunk(() => provider.unarchiveMessages(messageIds));
    case "mark_read":
      return wholeChunk(() => provider.markMessagesReadState(messageIds, true));
    case "mark_unread":
      return wholeChunk(() =>
        provider.markMessagesReadState(messageIds, false),
      );
    case "label":
      if (!labelId) return targets.length;
      return wholeChunk(() => provider.labelMessages(messageIds, labelId));
    case "delete_forever": {
      const deleteForever = provider.deleteMessagesForever?.bind(provider);
      if (!deleteForever) return targets.length;
      // Mail moved out of the trash since the listing is skipped, not failed.
      return wholeChunk(() => deleteForever(messageIds));
    }
    // Gmail trashes and reports spam by conversation, as its own select-all
    // does, so the rest of each conversation goes with it.
    case "trash":
      return eachThread((threadId) =>
        provider.trashThread(threadId, ownerEmail, "user"),
      );
    case "spam":
      return eachThread((threadId) => provider.markSpam(threadId));
  }
}

/**
 * The part of a view an action changes. Narrowing to it keeps the job small
 * and makes its undo exact: undoing "mark read" marks unread only what was
 * unread before.
 */
function filterForAction(action: MailBulkJobAction): MatchingFilter {
  switch (action) {
    case "archive":
      return { inInbox: true };
    case "mark_read":
      return { unread: true };
    case "mark_unread":
      return { unread: false };
    default:
      return {};
  }
}

function singleDeliveryTargetCap(
  action: MailBulkJobAction,
  provider: EmailProvider,
) {
  const batched =
    provider.name === "google" &&
    action !== "trash" &&
    action !== "spam" &&
    action !== "delete_forever";
  return batched
    ? SINGLE_DELIVERY_BATCH_TARGETS
    : SINGLE_DELIVERY_PER_ITEM_TARGETS;
}

// A deferral resumes the job later and lost access can't be retried past, so
// neither is counted as one chunk's failure.
function shouldStopJob(error: unknown) {
  return (
    Boolean(getGmailCallDeferredError(error)) || isInvalidGrantError(error)
  );
}
