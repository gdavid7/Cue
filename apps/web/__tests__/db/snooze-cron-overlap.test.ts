import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import { SnoozedThreadStatus } from "@/generated/prisma/enums";

vi.mock("server-only", () => ({}));

const restores = vi.hoisted(() => ({
  threadIds: [] as string[],
  failure: null as Error | null,
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    unarchiveThread: async (threadId: string) => {
      if (restores.failure) throw restores.failure;
      restores.threadIds.push(threadId);
      // Widens the window in which an overlapping run could slip in.
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
  })),
}));

const RUN_DB_TESTS = process.env.RUN_DB_TESTS;

// The scheduled-actions cron ticks more often than a run can last, so runs
// overlap and must never restore a thread twice, and a restore that can't
// succeed must not be retried at every tick forever.
describe.skipIf(!RUN_DB_TESTS)(
  "snooze wake-ups from frequent cron runs (real database)",
  { timeout: 30_000 },
  () => {
    let prisma: typeof import("@/utils/prisma").default;
    let processDueSnoozedThreads: typeof import("@/utils/snooze/process-due").processDueSnoozedThreads;
    let logger: import("@/utils/logger").Logger;

    const accountEmail = "snooze-cron-overlap-test@example.com";
    const disconnectedEmail = "snooze-cron-overlap-disconnected@example.com";

    beforeAll(async () => {
      prisma = (await import("@/utils/prisma")).default;
      ({ processDueSnoozedThreads } = await import(
        "@/utils/snooze/process-due"
      ));
      logger = (await import("@/utils/logger")).createScopedLogger(
        "snooze-cron-overlap-test",
      );
    });

    beforeEach(async () => {
      restores.threadIds = [];
      restores.failure = null;
      await prisma.user.deleteMany({
        where: { email: { in: [accountEmail, disconnectedEmail] } },
      });
    });

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { in: [accountEmail, disconnectedEmail] } },
      });
      await prisma.$disconnect();
    });

    test("restores each due thread once and leaves later ones pending", async () => {
      const emailAccountId = await seedAccount(prisma, accountEmail);
      const due = new Date(Date.now() - 60_000);
      const later = new Date(Date.now() + 60 * 60_000);
      await prisma.snoozedThread.createMany({
        data: [
          { emailAccountId, scheduledFor: due, threadId: "due-1" },
          { emailAccountId, scheduledFor: due, threadId: "due-2" },
          { emailAccountId, scheduledFor: later, threadId: "later" },
        ],
      });

      await Promise.all([
        processDueSnoozedThreads(logger),
        processDueSnoozedThreads(logger),
        processDueSnoozedThreads(logger),
      ]);

      expect([...restores.threadIds].sort()).toEqual(["due-1", "due-2"]);
      const rows = await prisma.snoozedThread.findMany({
        where: { emailAccountId },
        select: { threadId: true, status: true },
        orderBy: { threadId: "asc" },
      });
      expect(rows).toEqual([
        { threadId: "due-1", status: SnoozedThreadStatus.COMPLETED },
        { threadId: "due-2", status: SnoozedThreadStatus.COMPLETED },
        { threadId: "later", status: SnoozedThreadStatus.PENDING },
      ]);
    });

    test("leaves a disconnected mailbox's wake-up pending until it reconnects", async () => {
      const emailAccountId = await seedAccount(prisma, disconnectedEmail, {
        disconnectedAt: new Date(),
      });
      await prisma.snoozedThread.create({
        data: {
          emailAccountId,
          scheduledFor: new Date(Date.now() - 60_000),
          threadId: "disconnected",
        },
      });

      const result = await processDueSnoozedThreads(logger);

      expect(result.total).toBe(0);
      expect(restores.threadIds).toEqual([]);
      await expect(
        prisma.snoozedThread.findFirstOrThrow({ where: { emailAccountId } }),
      ).resolves.toMatchObject({ status: SnoozedThreadStatus.PENDING });

      await prisma.account.updateMany({
        where: { emailAccount: { id: emailAccountId } },
        data: { disconnectedAt: null },
      });
      await processDueSnoozedThreads(logger);

      expect(restores.threadIds).toEqual(["disconnected"]);
    });

    test("spaces out the retries of a failing restore, then gives up", async () => {
      const emailAccountId = await seedAccount(prisma, accountEmail);
      const snoozedThread = await prisma.snoozedThread.create({
        data: {
          emailAccountId,
          scheduledFor: new Date(Date.now() - 60_000),
          threadId: "keeps-failing",
        },
      });
      restores.failure = Object.assign(new Error("Backend Error"), {
        status: 503,
      });

      const waitsInMinutes: number[] = [];
      for (let attempt = 0; attempt < 20; attempt++) {
        const startedAt = Date.now();
        await processDueSnoozedThreads(logger);
        const row = await prisma.snoozedThread.findUniqueOrThrow({
          where: { id: snoozedThread.id },
        });
        if (row.status !== SnoozedThreadStatus.PENDING) break;
        waitsInMinutes.push(
          Math.round((row.scheduledFor.getTime() - startedAt) / 60_000),
        );
        // Time passes until the retry is due.
        await prisma.snoozedThread.update({
          where: { id: snoozedThread.id },
          data: { scheduledFor: new Date(Date.now() - 1000) },
        });
      }

      expect(waitsInMinutes).toEqual([5, 10, 20, 40, 80, 160, 320, 360, 360]);
      await expect(
        prisma.snoozedThread.findUniqueOrThrow({
          where: { id: snoozedThread.id },
        }),
      ).resolves.toMatchObject({
        status: SnoozedThreadStatus.CANCELLED,
        restoreAttempts: 10,
      });
    });

    test("ends a wake-up whose conversation is gone without retrying", async () => {
      const emailAccountId = await seedAccount(prisma, accountEmail);
      await prisma.snoozedThread.create({
        data: {
          emailAccountId,
          scheduledFor: new Date(Date.now() - 60_000),
          threadId: "deleted",
        },
      });
      restores.failure = Object.assign(new Error("Not Found"), { status: 404 });

      await processDueSnoozedThreads(logger);

      await expect(
        prisma.snoozedThread.findFirstOrThrow({ where: { emailAccountId } }),
      ).resolves.toMatchObject({ status: SnoozedThreadStatus.CANCELLED });
    });
  },
);

async function seedAccount(
  prisma: typeof import("@/utils/prisma").default,
  email: string,
  { disconnectedAt }: { disconnectedAt?: Date } = {},
) {
  const user = await prisma.user.create({ data: { email } });
  const account = await prisma.account.create({
    data: {
      userId: user.id,
      provider: "google",
      providerAccountId: `provider-${email}`,
      type: "oauth",
      disconnectedAt,
    },
  });
  const emailAccount = await prisma.emailAccount.create({
    data: { accountId: account.id, email, userId: user.id },
  });
  return emailAccount.id;
}
