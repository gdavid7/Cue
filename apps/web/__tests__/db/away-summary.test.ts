import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "vitest";
import {
  ActionType,
  ExecutedActionStatus,
  ExecutedRuleStatus,
} from "@/generated/prisma/enums";

const RUN_DB_TESTS = process.env.RUN_DB_TESTS;
const HOUR = 60 * 60_000;

describe.skipIf(!RUN_DB_TESTS)(
  "While you were away (real database)",
  { timeout: 30_000 },
  () => {
    let prisma: typeof import("@/utils/prisma").default;
    let recordLastLogin: typeof import("@/utils/user/last-login").recordLastLogin;
    let getAwaySummary: typeof import("@/utils/home/away-summary").getAwaySummary;
    let userId: string;
    let accountIds: string[];
    let otherAccountId: string;

    const emails = ["away-a@example.com", "away-b@example.com"];
    const otherEmail = "away-other@example.com";
    const now = new Date("2026-10-23T09:00:00.000Z");

    beforeAll(async () => {
      prisma = (await import("@/utils/prisma")).default;
      ({ recordLastLogin } = await import("@/utils/user/last-login"));
      ({ getAwaySummary } = await import("@/utils/home/away-summary"));
    });

    beforeEach(async () => {
      await prisma.user.deleteMany({
        where: { email: { in: [...emails, otherEmail] } },
      });
      const user = await prisma.user.create({ data: { email: emails[0] } });
      userId = user.id;
      accountIds = [];
      for (const email of emails)
        accountIds.push(await createEmailAccount(user.id, email));
      const other = await prisma.user.create({ data: { email: otherEmail } });
      otherAccountId = await createEmailAccount(other.id, otherEmail);
    });

    afterAll(async () => {
      await prisma.user.deleteMany({
        where: { email: { in: [...emails, otherEmail] } },
      });
    });

    test("a return after a break keeps when the user was last here", async () => {
      // First visit ever: there is no earlier one.
      await recordLastLogin(userId, new Date(now.getTime() - 20 * HOUR));
      expect(await visit()).toEqual({
        lastLogin: new Date(now.getTime() - 20 * HOUR),
        previousVisitAt: null,
      });

      // Still working: hourly writes don't start a new visit.
      await recordLastLogin(userId, new Date(now.getTime() - 18 * HOUR));
      expect((await visit()).previousVisitAt).toBeNull();

      // Back the next morning.
      await recordLastLogin(userId, now);
      expect(await visit()).toEqual({
        lastLogin: now,
        previousVisitAt: new Date(now.getTime() - 18 * HOUR),
      });

      // Today and the layout both record the same visit: it moves once.
      await recordLastLogin(userId, new Date(now.getTime() + 1000));
      expect((await visit()).previousVisitAt).toEqual(
        new Date(now.getTime() - 18 * HOUR),
      );
    });

    test("counts emails Cue sorted, archived and drafted since the last visit, per account", async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { previousVisitAt: new Date(now.getTime() - 12 * HOUR) },
      });
      const [a, b] = accountIds;
      const recent = new Date(now.getTime() - 2 * HOUR);
      // Two labels on one email sort one email.
      await run(a, "m1", recent, [ActionType.LABEL, ActionType.LABEL]);
      await run(a, "m2", recent, [ActionType.LABEL, ActionType.ARCHIVE]);
      await run(a, "m3", recent, [ActionType.DRAFT_EMAIL]);
      await run(b, "m4", recent, [ActionType.MOVE_FOLDER]);
      // Not Cue's work, didn't happen, or before the visit.
      await run(a, "m5", recent, [ActionType.ARCHIVE], { automated: false });
      await run(a, "m6", recent, [ActionType.ARCHIVE], {
        executionStatus: ExecutedActionStatus.FAILED,
      });
      await run(a, "m7", recent, [ActionType.ARCHIVE], {
        status: ExecutedRuleStatus.ERROR,
      });
      await run(a, "m8", new Date(now.getTime() - 13 * HOUR), [
        ActionType.ARCHIVE,
      ]);
      // Another user's account, even when asked for.
      await run(otherAccountId, "m9", recent, [ActionType.ARCHIVE]);

      const summary = await getAwaySummary({
        userId,
        emailAccountIds: [...accountIds, otherAccountId],
        now,
      });

      expect(summary).toEqual({
        since: new Date(now.getTime() - 12 * HOUR).toISOString(),
        capped: false,
        accounts: [
          { emailAccountId: a, sorted: 2, archived: 1, drafted: 1 },
          { emailAccountId: b, sorted: 1, archived: 0, drafted: 0 },
        ],
      });
    });

    test("a last visit over a week ago counts the last week only", async () => {
      await prisma.user.update({
        where: { id: userId },
        data: { previousVisitAt: new Date(now.getTime() - 30 * 24 * HOUR) },
      });
      await run(accountIds[0], "old", new Date(now.getTime() - 8 * 24 * HOUR), [
        ActionType.ARCHIVE,
      ]);
      await run(accountIds[0], "new", new Date(now.getTime() - 24 * HOUR), [
        ActionType.ARCHIVE,
      ]);

      const summary = await getAwaySummary({
        userId,
        emailAccountIds: [accountIds[0]],
        now,
      });

      expect(summary.capped).toBe(true);
      expect(summary.since).toBe(
        new Date(now.getTime() - 7 * 24 * HOUR).toISOString(),
      );
      expect(summary.accounts[0].archived).toBe(1);
    });

    test("no last visit, or a dismissed card, has nothing to show", async () => {
      await run(accountIds[0], "m1", now, [ActionType.ARCHIVE]);

      expect(
        await getAwaySummary({ userId, emailAccountIds: accountIds, now }),
      ).toEqual({ since: null, capped: false, accounts: [] });
    });

    async function visit() {
      return prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: { lastLogin: true, previousVisitAt: true },
      });
    }

    async function createEmailAccount(ownerId: string, email: string) {
      const account = await prisma.account.create({
        data: {
          userId: ownerId,
          provider: "google",
          providerAccountId: email,
          type: "oauth",
        },
      });
      const emailAccount = await prisma.emailAccount.create({
        data: { email, userId: ownerId, accountId: account.id },
      });
      return emailAccount.id;
    }

    async function run(
      emailAccountId: string,
      messageId: string,
      createdAt: Date,
      types: ActionType[],
      {
        automated = true,
        status = ExecutedRuleStatus.APPLIED,
        executionStatus = ExecutedActionStatus.SUCCEEDED,
      }: {
        automated?: boolean;
        status?: ExecutedRuleStatus;
        executionStatus?: ExecutedActionStatus;
      } = {},
    ) {
      await prisma.executedRule.create({
        data: {
          emailAccountId,
          threadId: `t-${messageId}`,
          messageId,
          status,
          automated,
          createdAt,
          actionItems: {
            create: types.map((type) => ({ type, executionStatus })),
          },
        },
      });
    }
  },
);
