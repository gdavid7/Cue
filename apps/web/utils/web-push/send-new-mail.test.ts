import { beforeEach, describe, expect, it, vi } from "vitest";
import webpush from "web-push";
import { createTestLogger } from "@/__tests__/helpers";
import { getMockParsedMessage } from "@/__tests__/mocks/email-provider.mock";
import { ActionType, SystemType, WebPushMode } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { getCueReadingType } from "@/utils/split-inbox/cue-membership.server";
import { sendNewMailWebPush } from "@/utils/web-push/send-new-mail";

const { vapid } = vi.hoisted(() => ({ vapid: { configured: true } }));

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/split-inbox/cue-membership.server", () => ({
  getCueReadingType: vi.fn(),
}));
vi.mock("web-push", () => ({
  default: { sendNotification: vi.fn() },
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

const logger = createTestLogger();
const now = new Date("2026-10-19T12:00:00Z");
const sendNotification = vi.mocked(webpush.sendNotification);

function message(overrides: Parameters<typeof getMockParsedMessage>[0] = {}) {
  return getMockParsedMessage({
    id: "message-1",
    threadId: "thread-1",
    labelIds: ["INBOX", "UNREAD"],
    internalDate: String(now.getTime() - 30_000),
    subject: "Quarterly numbers",
    headers: {
      from: "Ada Lovelace <ada@example.com>",
      to: "user@example.com",
      subject: "Quarterly numbers",
      date: now.toISOString(),
    },
    ...overrides,
  });
}

function subscription(
  id: string,
  mode: WebPushMode,
  quietUntil: Date | null = null,
) {
  return {
    id,
    endpoint: `https://fcm.googleapis.com/fcm/send/${id}`,
    p256dh: `p256dh-${id}`,
    auth: `auth-${id}`,
    mode,
    quietUntil,
  };
}

function send(
  overrides: Partial<Parameters<typeof sendNewMailWebPush>[0]> = {},
) {
  return sendNewMailWebPush({
    emailAccountId: "account-1",
    userId: "user-1",
    message: message(),
    logger,
    now,
    ...overrides,
  });
}

function sentEndpoints() {
  return sendNotification.mock.calls.map(([target]) => target.endpoint);
}

describe("sendNewMailWebPush", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vapid.configured = true;
    prisma.webPushSubscription.findMany.mockResolvedValue([
      subscription("important", WebPushMode.IMPORTANT),
      subscription("all", WebPushMode.ALL),
    ] as never);
    prisma.webPushDelivery.createMany.mockResolvedValue({ count: 1 });
    prisma.executedRule.findFirst.mockResolvedValue(null);
    vi.mocked(getCueReadingType).mockResolvedValue(null);
    sendNotification.mockResolvedValue({
      statusCode: 201,
      body: "",
      headers: {},
    });
  });

  it("pushes the sender, subject and thread link to every browser of the account's user", async () => {
    await send();

    expect(prisma.webPushSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { userId: "user-1" },
      }),
    );
    expect(sentEndpoints()).toEqual([
      "https://fcm.googleapis.com/fcm/send/important",
      "https://fcm.googleapis.com/fcm/send/all",
    ]);
    const [target, body, options] = sendNotification.mock.calls[0];
    expect(target.keys).toEqual({
      p256dh: "p256dh-important",
      auth: "auth-important",
    });
    expect(JSON.parse(body as string)).toEqual({
      title: "Ada Lovelace",
      body: "Quarterly numbers",
      tag: "cue-mail-account-1-message-1",
      url: "/account-1/mail?thread-id=thread-1",
      icon: expect.any(String),
    });
    expect(options?.vapidDetails).toEqual({
      subject: "mailto:ops@example.com",
      publicKey: "public-key",
      privateKey: "private-key",
    });
    expect(prisma.webPushSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: "important" },
      data: { lastSuccessAt: expect.any(Date), failureCount: 0 },
    });
  });

  it("only pushes to all-mail browsers when Cue sorted the thread into Reading", async () => {
    vi.mocked(getCueReadingType).mockResolvedValue(SystemType.NEWSLETTER);

    await send();

    expect(getCueReadingType).toHaveBeenCalledWith({
      emailAccountId: "account-1",
      threadId: "thread-1",
    });
    expect(sentEndpoints()).toEqual([
      "https://fcm.googleapis.com/fcm/send/all",
    ]);
  });

  it("treats mail Cue didn't sort into Reading as important", async () => {
    await send();

    expect(sentEndpoints()).toHaveLength(2);
  });

  it("skips the Reading lookup when every browser wants all mail", async () => {
    prisma.webPushSubscription.findMany.mockResolvedValue([
      subscription("all", WebPushMode.ALL),
    ] as never);

    await send();

    expect(getCueReadingType).not.toHaveBeenCalled();
    expect(sentEndpoints()).toHaveLength(1);
  });

  it("does not push mail a rule took out of the inbox", async () => {
    prisma.executedRule.findFirst.mockResolvedValue({ id: "run-1" } as never);

    await send();

    expect(prisma.executedRule.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        emailAccountId: "account-1",
        messageId: "message-1",
        actionItems: {
          some: {
            type: {
              in: [
                ActionType.ARCHIVE,
                ActionType.MOVE_FOLDER,
                ActionType.MARK_SPAM,
                ActionType.DELETE,
              ],
            },
          },
        },
      }),
      select: { id: true },
    });
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("pushes a message once when the webhook is retried", async () => {
    prisma.webPushDelivery.createMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await send();
    await send();

    expect(prisma.webPushDelivery.createMany).toHaveBeenCalledWith({
      data: [{ emailAccountId: "account-1", messageId: "message-1" }],
      skipDuplicates: true,
    });
    expect(sendNotification).toHaveBeenCalledTimes(2);
  });

  it("removes a subscription the push service says is gone", async () => {
    sendNotification
      .mockRejectedValueOnce(
        Object.assign(new Error("Gone"), { statusCode: 410 }),
      )
      .mockRejectedValueOnce(
        Object.assign(new Error("Not found"), { statusCode: 404 }),
      );

    await send();

    expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: "important" },
    });
    expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: "all" },
    });
  });

  it("counts other failures and drops a subscription after ten in a row", async () => {
    sendNotification.mockRejectedValue(
      Object.assign(new Error("Forbidden"), { statusCode: 403 }),
    );

    await send();

    expect(prisma.webPushSubscription.updateMany).toHaveBeenCalledWith({
      where: { id: "important" },
      data: { failureCount: { increment: 1 } },
    });
    expect(prisma.webPushSubscription.deleteMany).toHaveBeenCalledWith({
      where: { id: "important", failureCount: { gte: 10 } },
    });
    expect(prisma.webPushSubscription.deleteMany).not.toHaveBeenCalledWith({
      where: { id: "important" },
    });
  });

  it("does not count a network error on our side against the subscription", async () => {
    sendNotification.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));

    await send();

    expect(prisma.webPushSubscription.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: { failureCount: { increment: 1 } },
      }),
    );
    expect(prisma.webPushSubscription.deleteMany).not.toHaveBeenCalled();
  });

  it("skips mail outside the inbox, old mail and mail without a thread", async () => {
    await send({ message: message({ labelIds: ["SENT"] }) });
    await send({
      message: message({
        internalDate: String(now.getTime() - 60 * 60 * 1000),
      }),
    });
    await send({ message: message({ threadId: "" }) });

    expect(prisma.webPushDelivery.createMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("skips a browser paused past now and pushes to it once the pause ends", async () => {
    const pauseEnd = new Date(now.getTime() + 60 * 60 * 1000);
    prisma.webPushSubscription.findMany.mockResolvedValue([
      subscription("paused", WebPushMode.ALL, pauseEnd),
      subscription("ended", WebPushMode.ALL, new Date(now.getTime() - 1000)),
    ] as never);

    await send();
    expect(sentEndpoints()).toEqual([
      "https://fcm.googleapis.com/fcm/send/ended",
    ]);

    sendNotification.mockClear();
    const later = new Date(pauseEnd.getTime() + 1000);
    await send({
      now: later,
      message: message({
        id: "message-2",
        internalDate: String(later.getTime() - 30_000),
      }),
    });
    expect(sentEndpoints()).toEqual([
      "https://fcm.googleapis.com/fcm/send/paused",
      "https://fcm.googleapis.com/fcm/send/ended",
    ]);
  });

  it("does not claim a message when every browser is paused", async () => {
    prisma.webPushSubscription.findMany.mockResolvedValue([
      subscription("paused", WebPushMode.ALL, new Date(now.getTime() + 60_000)),
    ] as never);

    await send();

    expect(prisma.webPushDelivery.createMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });

  it("does nothing for a user with no subscribed browsers", async () => {
    prisma.webPushSubscription.findMany.mockResolvedValue([]);

    await send();

    expect(prisma.webPushDelivery.createMany).not.toHaveBeenCalled();
  });

  it("is off without VAPID keys", async () => {
    vapid.configured = false;

    await send();

    expect(prisma.webPushSubscription.findMany).not.toHaveBeenCalled();
    expect(sendNotification).not.toHaveBeenCalled();
  });
});
