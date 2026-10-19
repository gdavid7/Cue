import { z } from "zod";
import { MATCHING_BULK_ACTIONS } from "@/utils/actions/mail-bulk-matching.validation";
import { redis } from "@/utils/redis";

// Long enough to show the result and offer its undo the next day; the job's
// targets go with it.
const MAIL_BULK_JOB_TTL_SECONDS = 24 * 60 * 60;

export const MAIL_BULK_JOB_ACTIONS = [
  ...MATCHING_BULK_ACTIONS,
  "unarchive",
] as const;

export const MAIL_BULK_JOB_STATUSES = [
  "listing",
  "applying",
  "done",
  "cancelled",
  "failed",
] as const;

// Founder rule: job state holds ids and counts only, never mail content.
const mailBulkJobStateSchema = z.object({
  emailAccountId: z.string(),
  action: z.enum(MAIL_BULK_JOB_ACTIONS),
  status: z.enum(MAIL_BULK_JOB_STATUSES),
  labelId: z.string().optional(),
  /** The job whose targets this one restores, for an undo. */
  sourceJobId: z.string().optional(),
  /** Messages found to act on. */
  total: z.coerce.number().int().nonnegative(),
  /** Distinct conversations among them. */
  conversations: z.coerce.number().int().nonnegative(),
  /** Targets acted on so far, failed ones included, in list order. */
  applied: z.coerce.number().int().nonnegative(),
  failed: z.coerce.number().int().nonnegative(),
  /** The view held more than one job acts on. */
  capped: z.preprocess(
    (value) =>
      value === true || value === "true" || value === 1 || value === "1",
    z.boolean(),
  ),
});
export type MailBulkJobState = z.infer<typeof mailBulkJobStateSchema>;
export type MailBulkJobAction = MailBulkJobState["action"];

export type MailBulkTarget = { messageId: string; threadId: string };

export const mailBulkJobStore = {
  async create(jobId: string, state: MailBulkJobState) {
    const key = jobKey(jobId);
    await redis.hset(key, stripUndefined(state));
    await redis.expire(key, MAIL_BULK_JOB_TTL_SECONDS);
  },

  async get(jobId: string): Promise<MailBulkJobState | null> {
    const stored = await redis.hgetall<Record<string, unknown>>(jobKey(jobId));
    if (!stored) return null;
    const parsed = mailBulkJobStateSchema.safeParse(stored);
    return parsed.success ? parsed.data : null;
  },

  async update(
    jobId: string,
    fields: Partial<Pick<MailBulkJobState, "status" | "capped">>,
  ) {
    await redis.hset(jobKey(jobId), stripUndefined(fields));
  },

  async increment(
    jobId: string,
    field: "applied" | "failed" | "total" | "conversations",
    by: number,
  ) {
    if (!by) return;
    await redis.hincrby(jobKey(jobId), field, by);
  },

  /**
   * Adds a page of targets in list order, and resolves how many of their
   * conversations no earlier page held.
   */
  async appendTargets(jobId: string, targets: MailBulkTarget[]) {
    if (!targets.length) return 0;
    const listKey = targetsKey(jobId);
    const conversationsKey = conversationIdsKey(jobId);
    await redis.rpush(
      listKey,
      ...targets.map((target) => `${target.messageId} ${target.threadId}`),
    );
    const [firstThreadId, ...threadIds] = targets.map(
      (target) => target.threadId,
    );
    const added = await redis.sadd(
      conversationsKey,
      firstThreadId,
      ...threadIds,
    );
    await redis.expire(listKey, MAIL_BULK_JOB_TTL_SECONDS);
    await redis.expire(conversationsKey, MAIL_BULK_JOB_TTL_SECONDS);
    return added;
  },

  async readTargets(
    jobId: string,
    start: number,
    count: number,
  ): Promise<MailBulkTarget[]> {
    if (count <= 0) return [];
    const rows = await redis.lrange<string>(
      targetsKey(jobId),
      start,
      start + count - 1,
    );
    return rows.flatMap((row) => {
      const [messageId, threadId] = String(row).split(" ");
      return messageId && threadId ? [{ messageId, threadId }] : [];
    });
  },
};

function jobKey(jobId: string) {
  return `mail-bulk-job:${jobId}`;
}

function targetsKey(jobId: string) {
  return `mail-bulk-job:${jobId}:targets`;
}

function conversationIdsKey(jobId: string) {
  return `mail-bulk-job:${jobId}:conversations`;
}

function stripUndefined<T extends Record<string, unknown>>(value: T) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Record<string, unknown>;
}
