import { redis } from "@/utils/redis";
import {
  acquireOwnedLock,
  clearOwnedLock,
  markOwnedLockProcessed,
} from "@/utils/redis/owned-lock";

const OUTBOUND_PROCESSING_TTL_SECONDS = 60 * 30;
const OUTBOUND_PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 30;
const OUTBOUND_PROCESSED_STATUS = "processed";

function getProcessingKey({
  userEmail,
  messageId,
}: {
  userEmail: string;
  messageId: string;
}) {
  return `processing-message:${userEmail}:${messageId}`;
}

export async function markMessageAsProcessing({
  userEmail,
  messageId,
}: {
  userEmail: string;
  messageId: string;
}): Promise<boolean> {
  const result = await redis.set(
    getProcessingKey({ userEmail, messageId }),
    "true",
    {
      ex: 60 * 5, // 5 minutes
      nx: true, // Only set if key doesn't exist
    },
  );

  // Redis returns "OK" if the key was set, and null if it was already set
  return result === "OK";
}

const MESSAGE_PROCESSING_TTL_SECONDS = 60 * 5;
// Just past Gmail's usual week of history, so a catch-up never handles a
// message twice, without keeping a key per message for long after.
const MESSAGE_PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 8;
const MESSAGE_PROCESSED_STATUS = "processed";

const MESSAGE_RETRY_STATUS_PREFIX = "retry:";

/**
 * Claims a message for a Gmail history run. A message another run holds is
 * `held`; one handled before is `processed`, so a catch-up skips it with one
 * read instead of handling it again. One that failed is `retry-pending` until
 * its retry is due, so runs before then skip it just as cheaply.
 */
export async function acquireMessageProcessing(key: {
  userEmail: string;
  messageId: string;
}): Promise<
  | { status: "acquired"; lockToken: string }
  | { status: "held" }
  | { status: "processed" }
  | { status: "retry-pending"; retryAt: number }
> {
  try {
    const lockToken = await acquireOwnedLock({
      key: getProcessingKey(key),
      processingTtlSeconds: MESSAGE_PROCESSING_TTL_SECONDS,
    });
    if (lockToken) return { status: "acquired", lockToken };
    const stored = await redis.get<string>(getProcessingKey(key));
    if (stored === MESSAGE_PROCESSED_STATUS) return { status: "processed" };
    if (
      typeof stored === "string" &&
      stored.startsWith(MESSAGE_RETRY_STATUS_PREFIX)
    ) {
      const retryAt = Number(stored.slice(MESSAGE_RETRY_STATUS_PREFIX.length));
      if (Number.isFinite(retryAt)) return { status: "retry-pending", retryAt };
    }
    return { status: "held" };
  } catch (error) {
    throw new MessageLockUnavailableError(error);
  }
}

/**
 * Leaves a message that failed unclaimed until `retryAt`, when a run may try
 * it again. Only for a message whose claim was released, never one marked
 * processed.
 */
export async function deferMessageProcessing({
  retryAt,
  ...key
}: {
  userEmail: string;
  messageId: string;
  retryAt: number;
}) {
  await redis
    .multi()
    .set(getProcessingKey(key), `${MESSAGE_RETRY_STATUS_PREFIX}${retryAt}`, {
      px: Math.max(1, retryAt - Date.now()),
      nx: true,
    })
    .hset(getFailuresKey(key), { nextRetryAt: retryAt })
    .expire(getFailuresKey(key), MESSAGE_FAILURES_TTL_SECONDS)
    .exec();
}

/**
 * Redis could not say whether another run has the message, so it is neither
 * processed (it might be twice) nor skipped (it might be lost): the run stops
 * before it and a catch-up comes back for it.
 */
export class MessageLockUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Could not claim the message for processing", { cause });
    this.name = "MessageLockUnavailableError";
  }
}

export function isMessageLockUnavailableError(error: unknown) {
  return error instanceof MessageLockUnavailableError;
}

export async function markMessageProcessed({
  lockToken,
  ...key
}: {
  userEmail: string;
  messageId: string;
  lockToken: string;
}) {
  return markOwnedLockProcessed({
    key: getProcessingKey(key),
    lockToken,
    processedStatus: MESSAGE_PROCESSED_STATUS,
    processedTtlSeconds: MESSAGE_PROCESSED_TTL_SECONDS,
  });
}

export async function releaseMessageProcessing({
  lockToken,
  ...key
}: {
  userEmail: string;
  messageId: string;
  lockToken: string;
}) {
  return clearOwnedLock({ key: getProcessingKey(key), lockToken });
}

// As long as the processed marker, so a message is never retried afresh while
// a run could still reach it.
const MESSAGE_FAILURES_TTL_SECONDS = MESSAGE_PROCESSED_TTL_SECONDS;

/**
 * Counts one more run that failed to process a message for a reason that may
 * pass, and when it first failed, so a message that keeps failing is given up
 * on instead of holding the account's history back.
 */
export async function countMessageProcessingFailure(key: {
  userEmail: string;
  messageId: string;
}): Promise<{ failures: number; firstFailedAt: number }> {
  const failuresKey = getFailuresKey(key);
  // One transaction, so the count never outlives its expiry.
  const [failures, , , firstFailedAt] = await redis
    .multi()
    .hincrby(failuresKey, "failures", 1)
    .hsetnx(failuresKey, "firstFailedAt", Date.now())
    .expire(failuresKey, MESSAGE_FAILURES_TTL_SECONDS)
    .hget<number>(failuresKey, "firstFailedAt")
    .exec<[number, number, number, number | null]>();
  return { failures, firstFailedAt: Number(firstFailedAt ?? Date.now()) };
}

function getFailuresKey({
  userEmail,
  messageId,
}: {
  userEmail: string;
  messageId: string;
}) {
  return `processing-message-failures:${userEmail}:${messageId}`;
}

type OutboundMessageKey = {
  emailAccountId: string;
  messageId: string;
  lockToken?: string;
};

export async function acquireOutboundMessageLock({
  emailAccountId,
  messageId,
}: OutboundMessageKey): Promise<string | null> {
  return acquireOwnedLock({
    key: getOutboundMessageKey({ emailAccountId, messageId }),
    processingTtlSeconds: OUTBOUND_PROCESSING_TTL_SECONDS,
  });
}

export async function markOutboundMessageProcessed({
  emailAccountId,
  messageId,
  lockToken,
}: OutboundMessageKey): Promise<boolean> {
  return markOwnedLockProcessed({
    key: getOutboundMessageKey({ emailAccountId, messageId }),
    lockToken,
    processedStatus: OUTBOUND_PROCESSED_STATUS,
    processedTtlSeconds: OUTBOUND_PROCESSED_TTL_SECONDS,
  });
}

export async function clearOutboundMessageLock({
  emailAccountId,
  messageId,
  lockToken,
}: OutboundMessageKey): Promise<boolean> {
  return clearOwnedLock({
    key: getOutboundMessageKey({ emailAccountId, messageId }),
    lockToken,
  });
}

function getOutboundMessageKey({
  emailAccountId,
  messageId,
}: OutboundMessageKey) {
  return `reply-tracker:outbound-message:${emailAccountId}:${messageId}`;
}
