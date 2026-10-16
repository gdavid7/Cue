import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/upstash", () => ({ publishToQstashAt: vi.fn() }));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));

const durableSend = vi.hoisted(() => ({
  outcome: { status: "failed", error: "Recipient rejected" } as unknown,
}));
vi.mock("@/utils/email/durable-email-send", () => ({
  executeDurableEmailSend: vi.fn(async () => durableSend.outcome),
}));

const auth = vi.hoisted(() => ({ emailAccountId: "", userId: "" }));
vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      scopeOrHandler: unknown,
      handler?: (request: NextRequest) => Promise<Response>,
    ) =>
    (request: NextRequest) =>
      (handler ?? (scopeOrHandler as typeof handler))!(
        Object.assign(request, {
          auth: { emailAccountId: auth.emailAccountId, userId: auth.userId },
        }),
      ),
}));

const RUN_DB_TESTS = process.env.RUN_DB_TESTS;

// A reply sent now with a reminder keeps the reminder on the server's undo
// hold of the send. These cover what becomes of that hold.
describe.skipIf(!RUN_DB_TESTS)(
  "reminders on undo-window holds (real database)",
  { timeout: 60_000 },
  () => {
    let prisma: typeof import("@/utils/prisma").default;
    let service: typeof import("@/utils/scheduled-email/service");
    let retention: typeof import("@/utils/email-send-operation-retention");
    let route: typeof import("@/app/api/user/scheduled-emails/route");
    let logger: import("@/utils/logger").Logger;
    const accountEmail = "held-email-reminder-test@example.com";
    const afterRetryWindow = () =>
      new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);

    beforeAll(async () => {
      prisma = (await import("@/utils/prisma")).default;
      service = await import("@/utils/scheduled-email/service");
      retention = await import("@/utils/email-send-operation-retention");
      route = await import("@/app/api/user/scheduled-emails/route");
      logger = (await import("@/utils/logger")).createScopedLogger(
        "held-email-reminder-test",
      );
    });

    beforeEach(async () => {
      durableSend.outcome = { status: "failed", error: "Recipient rejected" };
      await prisma.user.deleteMany({ where: { email: accountEmail } });
      const seeded = await seedAccount(prisma, accountEmail);
      auth.emailAccountId = seeded.emailAccountId;
      auth.userId = seeded.userId;
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { email: accountEmail } });
      await prisma.$disconnect();
    });

    test("an undone send cancels its reminder and is cleaned up", async () => {
      const held = await hold();

      await expect(
        service.cancelHeldEmail(auth.emailAccountId, held.clientMutationId),
      ).resolves.toBe("cancelled");
      expect(await read(held.id)).toMatchObject({
        status: "CANCELLED",
        reminderStatus: "CANCELLED",
      });

      await retention.deleteExpiredEmailSendOperations(afterRetryWindow());
      expect(await read(held.id)).toBeNull();
    });

    test("a failed send cancels its reminder and is cleaned up", async () => {
      const held = await hold();

      await service.processScheduledEmail(held.id, logger, afterSendAt(held));
      expect(await read(held.id)).toMatchObject({
        status: "FAILED",
        reminderStatus: "CANCELLED",
      });

      await retention.deleteExpiredEmailSendOperations(afterRetryWindow());
      expect(await read(held.id)).toBeNull();
    });

    test("a sent hold stays while its reminder is to run, and is listed", async () => {
      const held = await hold();
      await prisma.scheduledEmail.update({
        where: { id: held.id },
        data: { status: "SENT", sentAt: new Date(), payload: {} },
      });
      const plain = await hold({ remindAt: null });
      await prisma.scheduledEmail.update({
        where: { id: plain.id },
        data: { status: "SENT", sentAt: new Date(), payload: {} },
      });
      const unsent = await hold();

      expect(await listedIds()).toEqual([held.id]);
      expect(unsent.status).toBe("PENDING");

      await retention.deleteExpiredEmailSendOperations(afterRetryWindow());
      expect(await read(held.id)).toMatchObject({ reminderStatus: "PENDING" });
      expect(await read(plain.id)).toBeNull();
    });

    // Reminders are sent long before they fall due, so by send time they
    // would always sort first and could fill the batch.
    test("sends a due email ahead of a full batch of older due reminders", async () => {
      const longAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      await prisma.scheduledEmail.createMany({
        data: Array.from({ length: 100 }, () => ({
          emailAccountId: auth.emailAccountId,
          clientMutationId: crypto.randomUUID(),
          payloadHash: "hash",
          payload: {},
          threadId: "thread-1",
          status: "SENT" as const,
          sendAt: longAgo,
          sentAt: longAgo,
          remindAt: new Date(Date.now() - 60_000),
          reminderStatus: "PENDING" as const,
        })),
      });
      const due = await hold({ remindAt: null });

      await service.processDueScheduledEmails(logger, afterSendAt(due));

      expect(await read(due.id)).toMatchObject({ status: "FAILED" });
    });

    async function hold({
      remindAt = new Date(Date.now() + 86_400_000).toISOString(),
    }: {
      remindAt?: string | null;
    } = {}) {
      return service.holdEmailForUndo({
        emailAccountId: auth.emailAccountId,
        input: {
          clientMutationId: crypto.randomUUID(),
          threadId: "thread-1",
          messageIds: ["message-1"],
          email: {
            to: "ada@example.com",
            subject: "Re: Plans",
            messageHtml: "<p>Thursday works.</p>",
          },
          sendAt: null,
          remindAt,
        },
        sendAt: new Date(Date.now() + 30_000),
        logger,
      });
    }

    function read(id: string) {
      return prisma.scheduledEmail.findUnique({
        where: { id },
        select: { status: true, reminderStatus: true },
      });
    }

    async function listedIds() {
      const response = await route.GET(
        new NextRequest(
          "http://localhost/api/user/scheduled-emails?threadId=thread-1",
        ),
        { params: Promise.resolve({}) },
      );
      const body = (await response.json()) as {
        scheduledEmails: { id: string }[];
      };
      return body.scheduledEmails.map((row) => row.id);
    }
  },
);

function afterSendAt(row: { sendAt: Date }) {
  return new Date(row.sendAt.getTime() + 1000);
}

async function seedAccount(
  prisma: typeof import("@/utils/prisma").default,
  email: string,
) {
  const user = await prisma.user.create({ data: { email } });
  const account = await prisma.account.create({
    data: {
      userId: user.id,
      provider: "google",
      providerAccountId: `provider-${email}`,
      type: "oauth",
    },
  });
  const emailAccount = await prisma.emailAccount.create({
    data: { accountId: account.id, email, userId: user.id },
  });
  return { emailAccountId: emailAccount.id, userId: user.id };
}
