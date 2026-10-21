"use server";

import { headers } from "next/headers";
import { WebPushMode } from "@/generated/prisma/enums";
import { actionClientUser } from "@/utils/actions/safe-action";
import {
  deleteWebPushSubscriptionBody,
  saveWebPushSubscriptionBody,
  setWebPushQuietUntilBody,
} from "@/utils/actions/web-push.validation";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import { MAX_QUIET_MS } from "@/utils/web-notifications/preference";
import { getWebPushVapidConfig } from "@/utils/web-push/config";

const USER_AGENT_MAX_LENGTH = 512;

export const saveWebPushSubscriptionAction = actionClientUser
  .metadata({ name: "saveWebPushSubscription" })
  .inputSchema(saveWebPushSubscriptionBody)
  .action(
    async ({
      ctx: { userId },
      parsedInput: { endpoint, keys, mode, quietUntil },
    }) => {
      if (!getWebPushVapidConfig())
        throw new SafeError("Push notifications aren't available.");

      const userAgent =
        (await headers()).get("user-agent")?.slice(0, USER_AGENT_MAX_LENGTH) ??
        null;
      const fields = {
        p256dh: keys.p256dh,
        auth: keys.auth,
        mode: mode === "all" ? WebPushMode.ALL : WebPushMode.IMPORTANT,
        userId,
        userAgent,
        quietUntil: toPauseEnd(quietUntil),
      };

      // The endpoint belongs to the browser, so whoever signs in there last
      // owns it, with this browser's pause rather than the last owner's.
      await prisma.webPushSubscription.upsert({
        where: { endpoint },
        create: { endpoint, ...fields },
        update: { ...fields, failureCount: 0 },
      });
    },
  );

export const deleteWebPushSubscriptionAction = actionClientUser
  .metadata({ name: "deleteWebPushSubscription" })
  .inputSchema(deleteWebPushSubscriptionBody)
  .action(async ({ ctx: { userId }, parsedInput: { endpoint } }) => {
    await prisma.webPushSubscription.deleteMany({
      where: { endpoint, userId },
    });
  });

// Scoped to the caller's own row, so knowing an endpoint is not enough to
// pause someone else's browser.
export const setWebPushQuietUntilAction = actionClientUser
  .metadata({ name: "setWebPushQuietUntil" })
  .inputSchema(setWebPushQuietUntilBody)
  .action(
    async ({ ctx: { userId }, parsedInput: { endpoint, quietUntil } }) => {
      await prisma.webPushSubscription.updateMany({
        where: { endpoint, userId },
        data: { quietUntil: toPauseEnd(quietUntil) },
      });
    },
  );

function toPauseEnd(quietUntil: number | null) {
  return quietUntil === null
    ? null
    : new Date(Math.min(quietUntil, Date.now() + MAX_QUIET_MS));
}
