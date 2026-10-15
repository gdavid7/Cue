import type { Client } from "@microsoft/microsoft-graph-client";
import type { Subscription } from "@microsoft/microsoft-graph-types";
import { env } from "@/env";
import { withMicrosoftGraphWriteRetry } from "@/utils/outlook/retry";
import type { Logger } from "@/utils/logger";

// Graph caps message subscriptions at 10,080 minutes (7 days). Stay a little
// under it so clock skew never gets the request rejected; the daily renewal
// then has about six days of slack before a subscription lapses.
export const OUTLOOK_SUBSCRIPTION_LIFETIME_MS = (10_080 - 144) * 60 * 1000;

export async function watchOutlook(client: Client, logger: Logger) {
  const base = env.WEBHOOK_URL || env.NEXT_PUBLIC_BASE_URL;

  // must be https
  const notificationUrl = new URL("/api/outlook/webhook", base);
  if (notificationUrl.protocol === "http:") {
    notificationUrl.protocol = "https:";
  }

  const subscriptionPayload = {
    changeType: "created,updated",
    notificationUrl: notificationUrl.toString(),
    lifecycleNotificationUrl: notificationUrl.toString(),
    resource: "/me/messages",
    expirationDateTime: getSubscriptionExpirationDateTime(),
    clientState: env.MICROSOFT_WEBHOOK_CLIENT_STATE,
  };

  const subscription: Subscription = await withMicrosoftGraphWriteRetry(
    () => client.api("/subscriptions").post(subscriptionPayload),
    logger,
  );

  return {
    id: subscription.id,
    expirationDateTime: subscription.expirationDateTime,
  };
}

/**
 * Extends an existing subscription, which Microsoft recommends over deleting
 * and recreating it (e.g. on reauthorizationRequired).
 */
export async function renewOutlookWatch(
  client: Client,
  subscriptionId: string,
  logger: Logger,
) {
  const subscription: Subscription = await withMicrosoftGraphWriteRetry(
    () =>
      client.api(`/subscriptions/${subscriptionId}`).patch({
        expirationDateTime: getSubscriptionExpirationDateTime(),
      }),
    logger,
  );

  return {
    id: subscription.id ?? subscriptionId,
    expirationDateTime: subscription.expirationDateTime,
  };
}

export async function unwatchOutlook(
  client: Client,
  subscriptionId: string,
  logger: Logger,
) {
  await withMicrosoftGraphWriteRetry(
    () => client.api(`/subscriptions/${subscriptionId}`).delete(),
    logger,
  );
}

function getSubscriptionExpirationDateTime() {
  return new Date(Date.now() + OUTLOOK_SUBSCRIPTION_LIFETIME_MS).toISOString();
}
