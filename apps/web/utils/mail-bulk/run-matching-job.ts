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
  type MailBulkJobAction,
  type MailBulkJobState,
  type MailBulkTarget,
  mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";
import { publishToQstash } from "@/utils/upstash";

export const MAIL_BULK_JOB_PATH = "/api/mail/bulk-matching";
export const MAIL_BULK_JOB_CALLER = "mail/bulk-matching";

// Each delivery stops well inside the route's five minutes and hands the
// rest to the next one.
const STEP_BUDGET_MS = 200_000;
// One Gmail batchModify takes up to 1000 ids; half keeps a failed chunk small.
const APPLY_CHUNK_SIZE = 500;
const PER_ITEM_CONCURRENCY = 2;
// A job's targets live in Redis until it expires; this bounds that list.
const MAX_JOB_TARGETS = 100_000;

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
 * background priority, so the quota gate only spends capacity nobody is using;
 * when it defers a call, the job resumes from where it stopped.
 */
export async function runMailBulkJobStep({
  body,
  provider,
  ownerEmail,
  logger,
  store = mailBulkJobStore,
  budgetMs = STEP_BUDGET_MS,
  maxTargets = MAX_JOB_TARGETS,
  now = Date.now,
}: {
  body: MailBulkJobBody;
  provider: EmailProvider;
  ownerEmail: string;
  logger: Logger;
  store?: typeof mailBulkJobStore;
  budgetMs?: number;
  maxTargets?: number;
  now?: () => number;
}): Promise<StepResult> {
  const job = await store.get(body.jobId);
  if (!job || job.emailAccountId !== body.emailAccountId) return "missing";
  if (isFinished(job.status)) return job.status;

  const startedAt = now();
  const outOfTime = () => now() - startedAt >= budgetMs;
  let pageToken = body.pageToken;

  try {
    return await runWithGmailQuota(
      { caller: MAIL_BULK_JOB_CALLER, priority: "background" },
      async () => {
        if (job.status === "listing") {
          if (!body.scope) {
            await store.update(body.jobId, { status: "failed" });
            return "failed";
          }
          let total = job.total;
          do {
            const page = await provider.listMatchingMessages({
              scope: body.scope,
              only: filterForAction(job.action),
              pageToken,
            });
            const room = maxTargets - total;
            const targets = page.messages.slice(0, room).map((message) => ({
              messageId: message.id,
              threadId: message.threadId,
            }));
            const conversations = await store.appendTargets(
              body.jobId,
              targets,
            );
            await store.increment(body.jobId, "total", targets.length);
            await store.increment(body.jobId, "conversations", conversations);
            total += targets.length;
            pageToken = page.nextPageToken;

            if (pageToken && total >= maxTargets) {
              await store.update(body.jobId, { capped: true });
              pageToken = undefined;
            }
            if (pageToken && outOfTime()) {
              await enqueueMailBulkJob({ ...body, pageToken, deferrals: 0 });
              return "continued";
            }
          } while (pageToken);
          await store.update(body.jobId, { status: "applying" });
        }

        return applyTargets({
          jobId: body.jobId,
          job,
          provider,
          ownerEmail,
          store,
          logger,
          outOfTime,
          continueLater: () =>
            enqueueMailBulkJob({
              jobId: body.jobId,
              emailAccountId: body.emailAccountId,
              deferrals: 0,
            }),
        });
      },
    );
  } catch (error) {
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
    if (resume === "not-deferred")
      logger.error("Bulk mail action failed", { error, action: job.action });
    await store.update(body.jobId, { status: "failed" });
    return "failed";
  }
}

async function applyTargets({
  jobId,
  job,
  provider,
  ownerEmail,
  store,
  logger,
  outOfTime,
  continueLater,
}: {
  jobId: string;
  job: MailBulkJobState;
  provider: EmailProvider;
  ownerEmail: string;
  store: typeof mailBulkJobStore;
  logger: Logger;
  outOfTime: () => boolean;
  continueLater: () => Promise<void>;
}): Promise<StepResult> {
  // An undo reads what its source job listed, up to how far that job got.
  const targetsJobId = job.sourceJobId ?? jobId;

  while (true) {
    const current = await store.get(jobId);
    if (!current) return "missing";
    if (isFinished(current.status)) return current.status;

    const limit = job.sourceJobId
      ? ((await store.get(job.sourceJobId))?.applied ?? 0)
      : current.total;
    const targets = await store.readTargets(
      targetsJobId,
      current.applied,
      Math.min(APPLY_CHUNK_SIZE, limit - current.applied),
    );
    if (!targets.length) {
      await store.update(jobId, { status: "done" });
      return "done";
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

  const wholeChunk = async (run: () => Promise<void>) => {
    try {
      await run();
      return 0;
    } catch (error) {
      if (shouldStopJob(error)) throw error;
      logger.warn("Bulk mail action chunk failed", { error, action });
      return targets.length;
    }
  };
  // `weight` is how many targets an item stands for, so a failed
  // conversation counts all of its messages.
  const eachItem = async (
    items: string[],
    run: (item: string) => Promise<unknown>,
    weight: (item: string) => number = () => 1,
  ) => {
    const results = await mapWithConcurrency(
      items,
      PER_ITEM_CONCURRENCY,
      async (item) => {
        try {
          await run(item);
          return 0;
        } catch (error) {
          if (shouldStopJob(error)) throw error;
          return weight(item);
        }
      },
    );
    const failed = results.reduce<number>((sum, count) => sum + count, 0);
    if (failed)
      logger.warn("Bulk mail action items failed", { failed, action });
    return failed;
  };
  const messagesInThread = (threadId: string) =>
    targets.filter((target) => target.threadId === threadId).length;

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
    case "delete_forever": {
      const deleteForever = provider.deleteMessagesForever?.bind(provider);
      if (!deleteForever) return targets.length;
      return wholeChunk(() => deleteForever(messageIds));
    }
    case "label":
      if (!labelId) return targets.length;
      return eachItem(messageIds, (messageId) =>
        provider.labelMessage({ messageId, labelId, labelName: null }),
      );
    // Gmail trashes and reports spam by conversation, as its own select-all
    // does, so the rest of each conversation goes with it.
    case "trash":
      return eachItem(
        threadIds,
        (threadId) => provider.trashThread(threadId, ownerEmail, "user"),
        messagesInThread,
      );
    case "spam":
      return eachItem(
        threadIds,
        (threadId) => provider.markSpam(threadId),
        messagesInThread,
      );
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

export async function enqueueMailBulkJob(body: MailBulkJobBody) {
  // One job per account at a time, so two of them never share its quota.
  await publishToQstash(MAIL_BULK_JOB_PATH, body, {
    key: `mail-bulk-${body.emailAccountId}`,
    parallelism: 1,
  });
}

// A deferral resumes the job later and lost access can't be retried past, so
// neither is counted as one chunk's failure.
function shouldStopJob(error: unknown) {
  return (
    Boolean(getGmailCallDeferredError(error)) || isInvalidGrantError(error)
  );
}

function isFinished(status: MailBulkJobState["status"]) {
  return status === "done" || status === "cancelled" || status === "failed";
}
