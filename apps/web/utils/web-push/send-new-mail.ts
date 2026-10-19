import webpush from "web-push";
import {
  ActionType,
  ExecutedRuleStatus,
  SystemType,
  WebPushMode,
} from "@/generated/prisma/enums";
import { mapWithConcurrency } from "@/utils/async";
import { BRAND_ICON_URL } from "@/utils/branding";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { truncate } from "@/utils/string";
import type { ParsedMessage } from "@/utils/types";
import {
  newMailNotificationTag,
  senderDisplayName,
} from "@/utils/web-notifications/new-mail";
import { getWebPushVapidConfig } from "@/utils/web-push/config";
import {
  newMailThreadPath,
  type NewMailPushPayload,
} from "@/utils/web-push/new-mail-payload";

// Catch-up runs replay older mail; a notification for it would be noise.
const NEW_MAIL_MAX_AGE_MS = 15 * 60 * 1000;
const CLOCK_SKEW_MS = 2 * 60 * 1000;
const SEND_CONCURRENCY = 4;
const SEND_TIMEOUT_MS = 10_000;
// A browser that stays offline longer than this gets nothing rather than
// stale mail alerts when it comes back.
const PUSH_TTL_SECONDS = 60 * 60;
const BULK_TYPES: SystemType[] = [SystemType.NEWSLETTER, SystemType.MARKETING];

/**
 * Pushes a new inbox message to the user's subscribed browsers. Runs after the
 * message's rules, so "important" browsers can skip what Cue triaged as bulk;
 * mail that triage didn't classify counts as important.
 */
export async function sendNewMailWebPush({
  emailAccountId,
  userId,
  message,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userId: string;
  message: ParsedMessage;
  logger: Logger;
  now?: Date;
}) {
  const vapid = getWebPushVapidConfig();
  if (!vapid) return;
  if (!message.threadId || !message.labelIds?.includes("INBOX")) return;
  const receivedAt = getMessageTimestamp(message);
  if (
    receivedAt <= 0 ||
    receivedAt < now.getTime() - NEW_MAIL_MAX_AGE_MS ||
    receivedAt > now.getTime() + CLOCK_SKEW_MS
  )
    return;

  const subscriptions = await prisma.webPushSubscription.findMany({
    where: {
      userId,
      OR: [{ emailAccountId: null }, { emailAccountId }],
    },
    select: { id: true, endpoint: true, p256dh: true, auth: true, mode: true },
  });
  if (subscriptions.length === 0) return;

  const claim = await prisma.webPushDelivery.createMany({
    data: [{ emailAccountId, messageId: message.id }],
    skipDuplicates: true,
  });
  if (claim.count === 0) return;

  const triage = await getTriageOutcome({
    emailAccountId,
    messageId: message.id,
  });
  if (triage.leftInbox) return;
  const targets = triage.bulk
    ? subscriptions.filter(({ mode }) => mode === WebPushMode.ALL)
    : subscriptions;
  if (targets.length === 0) return;

  const payload: NewMailPushPayload = {
    title: truncate(senderDisplayName(message.headers.from), 100),
    body: truncate(message.subject.trim() || "(no subject)", 200),
    tag: newMailNotificationTag(emailAccountId, message.id),
    url: newMailThreadPath(emailAccountId, message.threadId),
    icon: BRAND_ICON_URL,
  };
  const body = JSON.stringify(payload);

  await mapWithConcurrency(targets, SEND_CONCURRENCY, (subscription) =>
    deliver({ subscription, body, vapid, logger }).catch((error) =>
      logger.warn("Web push bookkeeping failed", { error }),
    ),
  );
}

async function getTriageOutcome({
  emailAccountId,
  messageId,
}: {
  emailAccountId: string;
  messageId: string;
}) {
  const executions = await prisma.executedRule.findMany({
    where: { emailAccountId, messageId, status: ExecutedRuleStatus.APPLIED },
    select: {
      rule: { select: { systemType: true } },
      actionItems: {
        where: { type: ActionType.ARCHIVE },
        select: { type: true },
      },
    },
  });
  return {
    bulk: executions.some(
      ({ rule }) => !!rule?.systemType && BULK_TYPES.includes(rule.systemType),
    ),
    leftInbox: executions.some(({ actionItems }) => actionItems.length > 0),
  };
}

async function deliver({
  subscription,
  body,
  vapid,
  logger,
}: {
  subscription: { id: string; endpoint: string; p256dh: string; auth: string };
  body: string;
  vapid: NonNullable<ReturnType<typeof getWebPushVapidConfig>>;
  logger: Logger;
}) {
  try {
    await webpush.sendNotification(
      {
        endpoint: subscription.endpoint,
        keys: { p256dh: subscription.p256dh, auth: subscription.auth },
      },
      body,
      {
        vapidDetails: vapid,
        TTL: PUSH_TTL_SECONDS,
        urgency: "high",
        timeout: SEND_TIMEOUT_MS,
      },
    );
  } catch (error) {
    const statusCode = getStatusCode(error);
    if (statusCode === 404 || statusCode === 410) {
      await prisma.webPushSubscription.deleteMany({
        where: { id: subscription.id },
      });
      return;
    }
    logger.warn("Web push send failed", { statusCode });
    await prisma.webPushSubscription.updateMany({
      where: { id: subscription.id },
      data: { failureCount: { increment: 1 } },
    });
    return;
  }
  await prisma.webPushSubscription.updateMany({
    where: { id: subscription.id },
    data: { lastSuccessAt: new Date(), failureCount: 0 },
  });
}

function getStatusCode(error: unknown) {
  if (error && typeof error === "object" && "statusCode" in error) {
    const { statusCode } = error;
    if (typeof statusCode === "number") return statusCode;
  }
  return null;
}
