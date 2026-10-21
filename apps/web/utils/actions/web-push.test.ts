import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import {
  deleteWebPushSubscriptionAction,
  saveWebPushSubscriptionAction,
  setWebPushQuietUntilAction,
} from "@/utils/actions/web-push";

const { vapid } = vi.hoisted(() => ({
  vapid: { configured: true },
}));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "owner@example.com" },
    session: {},
  })),
}));
vi.mock("next/headers", () => ({
  headers: vi.fn(async () => new Headers({ "user-agent": "Test Browser" })),
}));
vi.mock("@/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/env")>();
  return {
    ...actual,
    env: {
      ...actual.env,
      get VAPID_PUBLIC_KEY() {
        return vapid.configured ? "public-key" : undefined;
      },
      get VAPID_PRIVATE_KEY() {
        return vapid.configured ? "private-key" : undefined;
      },
      get VAPID_SUBJECT() {
        return vapid.configured ? "mailto:ops@example.com" : undefined;
      },
    },
  };
});

const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
  keys: { p256dh: "p256dh-key", auth: "auth-key" },
};

describe("web push subscription actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vapid.configured = true;
  });

  it("saves this browser's subscription with its notification mode", async () => {
    const result = await saveWebPushSubscriptionAction({
      ...subscription,
      mode: "important",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.webPushSubscription.upsert).toHaveBeenCalledWith({
      where: { endpoint: subscription.endpoint },
      create: expect.objectContaining({
        endpoint: subscription.endpoint,
        p256dh: "p256dh-key",
        auth: "auth-key",
        mode: "IMPORTANT",
        userId: "user-1",
        userAgent: "Test Browser",
      }),
      update: expect.objectContaining({
        mode: "IMPORTANT",
        userId: "user-1",
        failureCount: 0,
      }),
    });
  });

  it("switches an existing subscription to all new mail", async () => {
    await saveWebPushSubscriptionAction({ ...subscription, mode: "all" });

    expect(prisma.webPushSubscription.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ mode: "ALL" }),
      }),
    );
  });

  it("only accepts endpoints on a browser push service", async () => {
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://169.254.169.254/latest/meta-data",
      "https://evil.example.com/push",
      "https://fcm.googleapis.com.evil.example.com/push",
    ]) {
      const result = await saveWebPushSubscriptionAction({
        ...subscription,
        endpoint,
        mode: "all",
      });
      expect(result?.validationErrors).toBeTruthy();
    }
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      const result = await saveWebPushSubscriptionAction({
        ...subscription,
        endpoint,
        mode: "all",
      });
      expect(result?.validationErrors).toBeUndefined();
    }
    expect(prisma.webPushSubscription.upsert).toHaveBeenCalledTimes(3);
  });

  it("does not store a subscription for the off mode", async () => {
    const result = await saveWebPushSubscriptionAction({
      ...subscription,
      mode: "off" as never,
    });

    expect(result?.validationErrors).toBeTruthy();
    expect(prisma.webPushSubscription.upsert).not.toHaveBeenCalled();
  });

  it("removes only the signed-in user's subscription for this browser", async () => {
    const result = await deleteWebPushSubscriptionAction({
      endpoint: subscription.endpoint,
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { endpoint: subscription.endpoint, userId: "user-1" },
    });
  });

  it("pauses only the signed-in user's subscription for this browser", async () => {
    const quietUntil = Date.now() + 60 * 60 * 1000;

    const result = await setWebPushQuietUntilAction({
      endpoint: subscription.endpoint,
      quietUntil,
      userId: "user-2",
    } as never);

    expect(result?.serverError).toBeUndefined();
    expect(prisma.webPushSubscription.updateMany).toHaveBeenCalledWith({
      where: { endpoint: subscription.endpoint, userId: "user-1" },
      data: { quietUntil: new Date(quietUntil) },
    });
  });

  it("clears the pause when notifications resume", async () => {
    await setWebPushQuietUntilAction({
      endpoint: subscription.endpoint,
      quietUntil: null,
    });

    expect(prisma.webPushSubscription.updateMany).toHaveBeenCalledWith({
      where: { endpoint: subscription.endpoint, userId: "user-1" },
      data: { quietUntil: null },
    });
  });

  it("caps a pause at thirty days", async () => {
    const before = Date.now();
    await setWebPushQuietUntilAction({
      endpoint: subscription.endpoint,
      quietUntil: before + 90 * 24 * 60 * 60 * 1000,
    });

    const [{ data }] = prisma.webPushSubscription.updateMany.mock.calls[0];
    const stored = (data.quietUntil as Date).getTime();
    expect(stored).toBeGreaterThanOrEqual(before + 30 * 24 * 60 * 60 * 1000);
    expect(stored).toBeLessThanOrEqual(Date.now() + 30 * 24 * 60 * 60 * 1000);
  });

  it("is unavailable when web push isn't configured", async () => {
    vapid.configured = false;

    const result = await saveWebPushSubscriptionAction({
      ...subscription,
      mode: "all",
    });

    expect(result?.serverError).toBeTruthy();
    expect(prisma.webPushSubscription.upsert).not.toHaveBeenCalled();
  });
});
