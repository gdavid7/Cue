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
import { mailBulkJobListings } from "@/utils/mail-bulk/job-listing";
import {
  getGmailCallDeferredError,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";
import {
  ACTIVE_MAIL_BULK_JOB_STATUSES,
  isActiveMailBulkJob,
  isFinishedMailBulkJob,
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
// reliably, so one delivery does the whole job. Either way no new chunk
// starts in the route's last minute, so the one in flight can finish.
const DURABLE_STEP_BUDGET_MS = 200_000;
const SINGLE_DELIVERY_BUDGET_MS = 240_000;
// One Gmail batchModify takes up to 1000 ids; half keeps a failed chunk small.
const BATCH_CHUNK_SIZE = 500;
// Per-item work takes one request per conversation or message, so its
// chunks are small enough to finish well within the last minute.
const PER_ITEM_CHUNK_SIZE = 25;
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

// Founder rule: a queued delivery carries ids and counters only. The view it
// lists, which can hold the user's search text, and the page it reads next,
// which on Outlook repeats that search, stay in the job's Postgres listing.
const mailBulkJobQueuedBody = z.object({
  jobId: z.string().uuid(),
  emailAccountId: z.string().min(1),
  deferrals: z.number().int().nonnegative(),
});
type MailBulkJobQueuedBody = z.infer<typeof mailBulkJobQueuedBody>;

export const mailBulkJobBody = mailBulkJobQueuedBody.extend({
  // TODO(RD-3o): deliveries queued before the listing moved to Postgres still
  // carry these; drop them one deploy after it ships.
  scope: matchingScopeSchema.optional(),
  pageToken: z.string().optional(),
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
  listings = mailBulkJobListings,
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
  listings?: typeof mailBulkJobListings;
  /** Whether a scheduler can deliver the rest of the job later. */
  durable?: boolean;
  budgetMs?: number;
  maxTargets?: number;
  now?: () => number;
  wait?: (ms: number) => Promise<unknown>;
}): Promise<StepResult> {
  // A job that is gone or no longer running never lists again, so its view
  // goes too rather than waiting for the retention sweep.
  const endListing = () => listings.remove(body.jobId, body.emailAccountId);
  const job = await store.get(body.jobId);
  if (!job || job.emailAccountId !== body.emailAccountId) {
    await endListing();
    return "missing";
  }
  if (!isActiveMailBulkJob(job.status)) {
    await endListing();
    return settleStatus(store, body.jobId, job.status);
  }

  const deadline =
    now() +
    (budgetMs ??
      (durable ? DURABLE_STEP_BUDGET_MS : SINGLE_DELIVERY_BUDGET_MS));
  const outOfTime = () => now() >= deadline;
  const targetCap =
    maxTargets ??
    (durable ? MAX_JOB_TARGETS : singleDeliveryTargetCap(job.action, provider));
  const queuedBody = (deferrals = 0): MailBulkJobQueuedBody => ({
    jobId: body.jobId,
    emailAccountId: body.emailAccountId,
    deferrals,
  });

  const runPhases = async (): Promise<StepResult> => {
    const current = await store.get(body.jobId);
    if (!current) {
      await endListing();
      return "missing";
    }
    if (current.status === "listing") {
      const listing = await readListing(body, listings);
      if (!listing) {
        await store.transition(body.jobId, ["listing"], "failed");
        return "failed";
      }
      let { pageToken } = listing;
      let total = current.total;
      do {
        const page = await provider.listMatchingMessages({
          scope: listing.scope,
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
        // Saved before the next page is read, so a delivery that resumes
        // after a deferral or a timeout picks up here.
        await listings.setPageToken(body.jobId, body.emailAccountId, pageToken);

        // A Stop ends the listing at the page it lands on.
        const latest = await store.get(body.jobId);
        if (latest?.status !== "listing") {
          await endListing();
          return settleStatus(store, body.jobId, latest?.status);
        }

        if (pageToken && total >= targetCap) {
          await store.setCapped(body.jobId);
          pageToken = undefined;
        }
        if (pageToken && outOfTime()) {
          await enqueueMailBulkJob(queuedBody());
          return "continued";
        }
      } while (pageToken);
      await endListing();
      // A Stop during listing leaves the job cancelled rather than applying.
      const moved = await store.transition(body.jobId, ["listing"], "applying");
      if (!moved)
        return settleStatus(
          store,
          body.jobId,
          (await store.get(body.jobId))?.status,
        );
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
      continueLater: () => enqueueMailBulkJob(queuedBody()),
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
        body: queuedBody(body.deferrals),
        job,
        durable,
        store,
        endListing,
        logger,
      });
    }
  }
}

export async function enqueueMailBulkJob(body: MailBulkJobQueuedBody) {
  // One job per account at a time, so two of them never share its quota.
  await publishToQstash(MAIL_BULK_JOB_PATH, body, {
    key: `mail-bulk-${body.emailAccountId}`,
    parallelism: 1,
  });
}

async function failOrResume({
  error,
  body,
  job,
  durable,
  store,
  endListing,
  logger,
}: {
  error: unknown;
  body: MailBulkJobQueuedBody;
  job: MailBulkJobState;
  durable: boolean;
  store: typeof mailBulkJobStore;
  endListing: () => Promise<void>;
  logger: Logger;
}): Promise<StepResult> {
  const deferred = getGmailCallDeferredError(error);
  if (deferred && durable) {
    const latest = await store.get(body.jobId);
    const resume = await resumeAfterGmailDeferral({
      error,
      path: MAIL_BULK_JOB_PATH,
      body,
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
    // Only the error's kind: a Graph error carries the request it failed on,
    // which repeats the view's search.
    logger.error("Bulk mail action failed", {
      action: job.action,
      ...describeError(error),
    });
  }
  await endListing();
  // A job asked to stop ends as stopped, not failed.
  if (await store.transition(body.jobId, ["stopping"], "cancelled"))
    return "cancelled";
  await store.transition(body.jobId, ACTIVE_MAIL_BULK_JOB_STATUSES, "failed");
  return "failed";
}

/**
 * The step's result for a job no longer listing or applying. A job asked to
 * stop is only marked cancelled here, by the delivery, once the chunk it was
 * in has been counted, so an undo waiting on it sees every change it made.
 */
async function settleStatus(
  store: typeof mailBulkJobStore,
  jobId: string,
  status: MailBulkJobState["status"] | undefined,
): Promise<StepResult> {
  if (!status) return "missing";
  if (status !== "stopping") return status;
  await store.transition(jobId, ["stopping"], "cancelled");
  return (await store.get(jobId))?.status ?? "missing";
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
  // Progress is saved after each chunk, so a delivery cut off mid-chunk only
  // redoes that one; per-item chunks stay small for that reason.
  const chunkSize = isBatchedAction(job.action, provider)
    ? BATCH_CHUNK_SIZE
    : PER_ITEM_CHUNK_SIZE;
  // An undo reads how far its source got only once the source has finished
  // (or lost its delivery), so a chunk still in flight when Undo was pressed
  // is restored too.
  const targetsJobId = job.sourceJobId ?? jobId;
  let limit: number | undefined;
  if (job.sourceJobId) {
    while (true) {
      const source = await store.get(job.sourceJobId);
      if (
        !source ||
        isFinishedMailBulkJob(source.status) ||
        isStaleMailBulkJob(source)
      ) {
        limit = source?.applied ?? 0;
        break;
      }
      if (outOfTime()) {
        await continueLater();
        return "continued";
      }
      // Waiting is progress too: without this, a source slow to stop could
      // make the undo itself read as stale and be failed before it restores.
      await store.touch(jobId);
      await wait(SOURCE_WAIT_MS);
    }
  }

  while (true) {
    const current = await store.get(jobId);
    if (!current) return "missing";
    if (current.status !== "applying")
      return settleStatus(store, jobId, current.status);

    const end = limit ?? current.total;
    const targets = await store.readTargets(
      targetsJobId,
      current.applied,
      Math.min(chunkSize, end - current.applied),
    );
    if (!targets.length) {
      const moved = await store.transition(jobId, ["applying"], "done");
      return moved
        ? "done"
        : settleStatus(store, jobId, (await store.get(jobId))?.status);
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
  return isBatchedAction(action, provider)
    ? SINGLE_DELIVERY_BATCH_TARGETS
    : SINGLE_DELIVERY_PER_ITEM_TARGETS;
}

/**
 * Gmail's batch calls change many messages in one request; conversation
 * trash and spam, deleting forever, and every Outlook call go one by one.
 */
function isBatchedAction(action: MailBulkJobAction, provider: EmailProvider) {
  return (
    provider.name === "google" &&
    action !== "trash" &&
    action !== "spam" &&
    action !== "delete_forever"
  );
}

// A deferral resumes the job later and lost access can't be retried past, so
// neither is counted as one chunk's failure.
function shouldStopJob(error: unknown) {
  return (
    Boolean(getGmailCallDeferredError(error)) || isInvalidGrantError(error)
  );
}

/**
 * The view a listing job reads and the page it is on, from its Postgres row
 * for the job's own account.
 */
async function readListing(
  body: MailBulkJobBody,
  listings: typeof mailBulkJobListings,
) {
  const listing = await listings.get(body.jobId, body.emailAccountId);
  if (listing || !body.scope) return listing;
  // TODO(RD-3o): a delivery queued before the listing moved to Postgres moves
  // it there, so the deliveries after it carry ids only.
  const legacy = { scope: body.scope, pageToken: body.pageToken };
  await listings.create({
    jobId: body.jobId,
    emailAccountId: body.emailAccountId,
    ...legacy,
  });
  return legacy;
}

function describeError(error: unknown) {
  if (!(error instanceof Error)) return { errorName: typeof error };
  const { code, statusCode } = error as {
    code?: unknown;
    statusCode?: unknown;
  };
  return {
    errorName: error.name,
    errorCode: typeof code === "string" ? code : undefined,
    statusCode: typeof statusCode === "number" ? statusCode : undefined,
  };
}
