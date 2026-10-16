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
// Past Gmail's history retention, so a catch-up never handles a message twice.
const MESSAGE_PROCESSED_TTL_SECONDS = 60 * 60 * 24 * 30;
const MESSAGE_PROCESSED_STATUS = "processed";

/**
 * Claims a message for a Gmail history run. A message another run holds is
 * `held`; one handled before is `processed`, so a catch-up skips it with one
 * read instead of handling it again.
 */
export async function acquireMessageProcessing(key: {
  userEmail: string;
  messageId: string;
}): Promise<
  | { status: "acquired"; lockToken: string }
  | { status: "held" }
  | { status: "processed" }
> {
  const lockToken = await acquireOwnedLock({
    key: getProcessingKey(key),
    processingTtlSeconds: MESSAGE_PROCESSING_TTL_SECONDS,
  });
  if (lockToken) return { status: "acquired", lockToken };
  const stored = await redis.get<string>(getProcessingKey(key));
  return stored === MESSAGE_PROCESSED_STATUS
    ? { status: "processed" }
    : { status: "held" };
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
