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
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe.skipIf(!RUN_DB_TESTS)(
  "While you were away (real database)",
  { timeout: 30_000 },
  () => {
    let prisma: typeof import("@/utils/prisma").default;
    let recordLastLogin: typeof import("@/utils/user/last-login").recordLastLogin;
    let getAwaySummary: typeof import("@/utils/home/away-summary").getAwaySummary;
    let dismissAwaySummary: typeof import("@/utils/home/away-summary").dismissAwaySummary;
    let ruleIds: Record<string, string>;
    let userId: string;
    let accountIds: string[];
    let otherAccountId: string;

    const emails = ["away-a@example.com", "away-b@example.com"];
    const otherEmail = "away-other@example.com";
    const now = new Date("2026-10-23T09:00:00.000Z");

    beforeAll(async () => {
      prisma = (await import("@/utils/prisma")).default;
      ({ recordLastLogin } = await import("@/utils/user/last-login"));
      ({ getAwaySummary, dismissAwaySummary } = await import(
        "@/utils/home/away-summary"
      ));
    });

    beforeEach(async () => {
      await prisma.user.deleteMany({
        where: { email: { in: [...emails, otherEmail] } },
      });
      const user = await prisma.user.create({ data: { email: emails[0] } });
      userId = user.id;
      accountIds = [];
      ruleIds = {};
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

    test("a return after a break keeps when the user was last here and when they came back", async () => {
      // First visit ever: there is no earlier one.
      await recordLastLogin(userId, at(-20 * HOUR));
      expect(await visit()).toEqual({
        lastLogin: at(-20 * HOUR),
        previousVisitAt: null,
        visitReturnedAt: null,
      });

      // Still working: the browser's ten-minute records don't start a visit.
      await recordLastLogin(userId, at(-18 * HOUR));
      expect((await visit()).previousVisitAt).toBeNull();

      // Back the next morning.
      await recordLastLogin(userId, now);
      expect(await visit()).toEqual({
        lastLogin: now,
        previousVisitAt: at(-18 * HOUR),
        visitReturnedAt: now,
      });

      // Two tabs record the same return: it moves once.
      await recordLastLogin(userId, at(11 * MINUTE));
      expect(await visit()).toMatchObject({
        previousVisitAt: at(-18 * HOUR),
        visitReturnedAt: now,
      });
    });

    test("five hours working in Mail, then opening Today, shows no card", async () => {
      // Last here yesterday evening; back at nine, sees the card, dismisses it.
      await recordLastLogin(userId, at(-15 * HOUR));
      await recordLastLogin(userId, now);
      const card = await getAwaySummary({
        userId,
        emailAccountIds: accountIds,
        now,
      });
      expect(card.lastVisitAt).toBe(at(-15 * HOUR).toISOString());
      await dismissAwaySummary({ userId, lastVisitAt: at(-15 * HOUR) });

      // Works in Mail until two: the browser records every ten minutes,
      // while Cue keeps sorting mail.
      for (let minute = 10; minute <= 5 * 60; minute += 10) {
        await recordLastLogin(userId, at(minute * MINUTE));
      }
      await run(accountIds[0], "m1", at(3 * HOUR), [ActionType.ARCHIVE]);

      const today = at(5 * HOUR);
      await recordLastLogin(userId, today);
      expect(
        await getAwaySummary({
          userId,
          emailAccountIds: accountIds,
          now: today,
        }),
      ).toMatchObject({ since: null, accounts: [] });
    });

    test("counts emails Cue sorted, archived and drafted between the last visit and the return, per account", async () => {
      await setVisit(at(-12 * HOUR), at(-1 * HOUR));
      const [a, b] = accountIds;
      const away = at(-2 * HOUR);
      // Two labels on one email sort one email.
      await run(a, "m1", away, [ActionType.LABEL, ActionType.LABEL]);
      await run(a, "m2", away, [ActionType.LABEL, ActionType.ARCHIVE]);
      await run(a, "m3", away, [ActionType.DRAFT_EMAIL]);
      await run(b, "m4", away, [ActionType.MOVE_FOLDER]);
      // Not Cue's work, didn't happen, before the visit, or after the return.
      await run(a, "m5", away, [ActionType.ARCHIVE], { automated: false });
      await run(a, "m6", away, [ActionType.ARCHIVE], {
        executionStatus: ExecutedActionStatus.FAILED,
      });
      await run(a, "m7", away, [ActionType.ARCHIVE], {
        status: ExecutedRuleStatus.ERROR,
      });
      await run(a, "m8", at(-13 * HOUR), [ActionType.ARCHIVE]);
      await run(a, "m9", at(-30 * MINUTE), [ActionType.ARCHIVE]);
      // A run whose rule was deleted isn't in History either.
      await run(a, "m10", away, [ActionType.ARCHIVE], { ruleId: null });
      // Another user's account, even when asked for.
      await run(otherAccountId, "m11", away, [ActionType.ARCHIVE]);

      const summary = await getAwaySummary({
        userId,
        emailAccountIds: [...accountIds, otherAccountId],
        now,
      });

      expect(summary).toEqual({
        since: at(-12 * HOUR).toISOString(),
        until: at(-1 * HOUR).toISOString(),
        capped: false,
        lastVisitAt: at(-12 * HOUR).toISOString(),
        accounts: [
          { emailAccountId: a, sorted: 2, archived: 1, drafted: 1 },
          { emailAccountId: b, sorted: 1, archived: 0, drafted: 0 },
        ],
      });
    });

    test("the card goes 12 hours after the return", async () => {
      await setVisit(at(-24 * HOUR), now);
      await run(accountIds[0], "m1", at(-2 * HOUR), [ActionType.ARCHIVE]);

      const shown = (ms: number) =>
        getAwaySummary({ userId, emailAccountIds: accountIds, now: at(ms) });
      expect((await shown(12 * HOUR)).accounts[0].archived).toBe(1);
      expect(await shown(12 * HOUR + MINUTE)).toMatchObject({ since: null });
    });

    test("a last visit over a week before the return counts that week only", async () => {
      await setVisit(at(-30 * 24 * HOUR), now);
      await run(accountIds[0], "old", at(-8 * 24 * HOUR), [ActionType.ARCHIVE]);
      await run(accountIds[0], "new", at(-24 * HOUR), [ActionType.ARCHIVE]);

      const summary = await getAwaySummary({
        userId,
        emailAccountIds: [accountIds[0]],
        now,
      });

      expect(summary.capped).toBe(true);
      expect(summary.since).toBe(at(-7 * 24 * HOUR).toISOString());
      expect(summary.lastVisitAt).toBe(at(-30 * 24 * HOUR).toISOString());
      expect(summary.accounts[0].archived).toBe(1);
    });

    test("dismissing clears only the visit the card showed", async () => {
      await setVisit(at(-24 * HOUR), now);
      // A tab still showing an earlier return's card can't wipe this one.
      expect(
        await dismissAwaySummary({ userId, lastVisitAt: at(-48 * HOUR) }),
      ).toBe(false);
      expect(await visit()).toMatchObject({ previousVisitAt: at(-24 * HOUR) });

      expect(
        await dismissAwaySummary({ userId, lastVisitAt: at(-24 * HOUR) }),
      ).toBe(true);
      expect(await visit()).toMatchObject({
        previousVisitAt: null,
        visitReturnedAt: null,
      });
      await run(accountIds[0], "m1", at(-HOUR), [ActionType.ARCHIVE]);
      expect(
        await getAwaySummary({ userId, emailAccountIds: accountIds, now }),
      ).toMatchObject({ since: null, accounts: [] });
    });

    function at(offsetMs: number) {
      return new Date(now.getTime() + offsetMs);
    }

    async function setVisit(previousVisitAt: Date, visitReturnedAt: Date) {
      await prisma.user.update({
        where: { id: userId },
        data: { previousVisitAt, visitReturnedAt, lastLogin: visitReturnedAt },
      });
    }

    async function visit() {
      return prisma.user.findUniqueOrThrow({
        where: { id: userId },
        select: {
          lastLogin: true,
          previousVisitAt: true,
          visitReturnedAt: true,
        },
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
      const rule = await prisma.rule.create({
        data: { name: "Away test rule", emailAccountId: emailAccount.id },
      });
      ruleIds[emailAccount.id] = rule.id;
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
        ruleId = ruleIds[emailAccountId],
      }: {
        automated?: boolean;
        status?: ExecutedRuleStatus;
        executionStatus?: ExecutedActionStatus;
        ruleId?: string | null;
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
          ruleId,
          actionItems: {
            create: types.map((type) => ({ type, executionStatus })),
          },
        },
      });
    }
  },
);
