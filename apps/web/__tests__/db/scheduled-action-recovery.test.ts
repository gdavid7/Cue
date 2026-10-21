import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
import {
  ActionType,
  ExecutedActionStatus,
  ExecutedRuleStatus,
  ScheduledActionStatus,
} from "@/generated/prisma/enums";

vi.mock("server-only", () => ({}));

const provider = vi.hoisted(() => ({
  // Action types the mailbox carried out, in order.
  calls: [] as string[],
  // Lets a test look at the database at the moment the provider is called.
  onCall: null as null | ((action: { id: string; type: string }) => unknown),
}));

vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(async () => ({
    getMessage: async (messageId: string) => ({
      id: messageId,
      threadId: "thread-1",
      headers: {},
      textPlain: "",
      textHtml: "",
      snippet: "",
      attachments: [],
      internalDate: "1700000000000",
    }),
  })),
}));
vi.mock("@/utils/ai/actions", () => ({
  runActionFunction: vi.fn(
    async ({ action }: { action: { id: string; type: string } }) => {
      await provider.onCall?.(action);
      provider.calls.push(action.type);
      // Widens the window in which an overlapping run could slip in.
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { sentMessageIds: [] };
    },
  ),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAiAndTokens: vi.fn(
    async ({ emailAccountId }: { emailAccountId: string }) => ({
      id: emailAccountId,
      email: accountEmail,
      userId: "user-1",
    }),
  ),
}));

const RUN_DB_TESTS = process.env.RUN_DB_TESTS;
const accountEmail = "scheduled-action-recovery-test@example.com";
const STALE_START = new Date(Date.now() - 60 * 60_000);

// A run killed mid-action leaves the action EXECUTING. The cron must finish it
// without ever sending an email twice.
describe.skipIf(!RUN_DB_TESTS)(
  "recovering scheduled actions from killed runs (real database)",
  { timeout: 30_000 },
  () => {
    let prisma: typeof import("@/utils/prisma").default;
    let recoverStaleScheduledActions: typeof import("@/utils/scheduled-actions/recovery").recoverStaleScheduledActions;
    let executeScheduledAction: typeof import("@/utils/scheduled-actions/executor").executeScheduledAction;
    let markQStashActionAsExecuting: typeof import("@/utils/scheduled-actions/scheduler").markQStashActionAsExecuting;
    let logger: import("@/utils/logger").Logger;
    let emailAccountId: string;

    beforeAll(async () => {
      prisma = (await import("@/utils/prisma")).default;
      ({ recoverStaleScheduledActions } = await import(
        "@/utils/scheduled-actions/recovery"
      ));
      ({ executeScheduledAction } = await import(
        "@/utils/scheduled-actions/executor"
      ));
      ({ markQStashActionAsExecuting } = await import(
        "@/utils/scheduled-actions/scheduler"
      ));
      logger = (await import("@/utils/logger")).createScopedLogger(
        "scheduled-action-recovery-test",
      );
    });

    beforeEach(async () => {
      provider.calls = [];
      provider.onCall = null;
      await prisma.user.deleteMany({ where: { email: accountEmail } });
      emailAccountId = await seedAccount(prisma, accountEmail);
    });

    afterAll(async () => {
      await prisma.user.deleteMany({ where: { email: accountEmail } });
      await prisma.$disconnect();
    });

    test("links the executed action before the provider call", async () => {
      const { scheduledActionId } = await seedScheduledAction({
        actionType: ActionType.REPLY,
        status: ScheduledActionStatus.PENDING,
      });
      let linkedAtCall: string | null | undefined;
      provider.onCall = async (action) => {
        const row = await prisma.scheduledAction.findUniqueOrThrow({
          where: { id: scheduledActionId },
        });
        linkedAtCall = row.executedActionId;
        expect(row.executedActionId).toBe(action.id);
      };

      const claimed = await markQStashActionAsExecuting(scheduledActionId);
      expect(claimed).toMatchObject({
        status: ScheduledActionStatus.EXECUTING,
        executionAttempts: 1,
        executionStartedAt: expect.any(Date),
      });
      await executeScheduledAction(claimed!, await getProvider(), logger);

      expect(provider.calls).toEqual([ActionType.REPLY]);
      expect(linkedAtCall).toEqual(expect.any(String));
      await expect(
        getScheduledAction(scheduledActionId),
      ).resolves.toMatchObject({ status: ScheduledActionStatus.COMPLETED });
    });

    test("retries an interrupted archive once, even with overlapping runs", async () => {
      const { scheduledActionId, executedRuleId } = await seedScheduledAction({
        actionType: ActionType.ARCHIVE,
        withExecutedAction: true,
      });

      await Promise.all([
        recoverStaleScheduledActions(logger),
        recoverStaleScheduledActions(logger),
        recoverStaleScheduledActions(logger),
      ]);

      expect(provider.calls).toEqual([ActionType.ARCHIVE]);
      const row = await getScheduledAction(scheduledActionId);
      expect(row).toMatchObject({
        status: ScheduledActionStatus.COMPLETED,
        executionAttempts: 2,
      });
      // The retry reuses the record of the interrupted run.
      expect(row.executedAction).toMatchObject({
        executionStatus: ExecutedActionStatus.SUCCEEDED,
      });
      await expect(
        prisma.executedAction.count({ where: { executedRuleId } }),
      ).resolves.toBe(1);
      await expectExecutedRuleStatus(
        executedRuleId,
        ExecutedRuleStatus.APPLIED,
      );
    });

    test("never resends an interrupted reply whose outcome is unknown", async () => {
      const { scheduledActionId, executedRuleId } = await seedScheduledAction({
        actionType: ActionType.REPLY,
        withExecutedAction: true,
      });

      await recoverStaleScheduledActions(logger);
      await recoverStaleScheduledActions(logger);

      expect(provider.calls).toEqual([]);
      const row = await getScheduledAction(scheduledActionId);
      expect(row.status).toBe(ScheduledActionStatus.FAILED);
      expect(row.executedAction).toMatchObject({
        executionStatus: ExecutedActionStatus.FAILED,
        executionError: expect.objectContaining({
          code: "SEND_OUTCOME_UNKNOWN",
        }),
      });
      await expectExecutedRuleStatus(executedRuleId, ExecutedRuleStatus.ERROR);
    });

    test("completes an interrupted reply that had already been sent", async () => {
      const { scheduledActionId, executedRuleId } = await seedScheduledAction({
        actionType: ActionType.REPLY,
        withExecutedAction: true,
        executedActionStatus: ExecutedActionStatus.SUCCEEDED,
      });

      await recoverStaleScheduledActions(logger);

      expect(provider.calls).toEqual([]);
      await expect(
        getScheduledAction(scheduledActionId),
      ).resolves.toMatchObject({
        status: ScheduledActionStatus.COMPLETED,
        executedAt: expect.any(Date),
      });
      await expectExecutedRuleStatus(
        executedRuleId,
        ExecutedRuleStatus.APPLIED,
      );
    });

    test("sends a reply whose run died before reaching the provider", async () => {
      const { scheduledActionId, executedRuleId } = await seedScheduledAction({
        actionType: ActionType.REPLY,
      });

      await recoverStaleScheduledActions(logger);
      await recoverStaleScheduledActions(logger);

      expect(provider.calls).toEqual([ActionType.REPLY]);
      await expect(
        getScheduledAction(scheduledActionId),
      ).resolves.toMatchObject({ status: ScheduledActionStatus.COMPLETED });
      await expectExecutedRuleStatus(
        executedRuleId,
        ExecutedRuleStatus.APPLIED,
      );
    });

    test("fails a reply stuck before leases were recorded instead of resending it", async () => {
      const { scheduledActionId, executedRuleId } = await seedScheduledAction({
        actionType: ActionType.FORWARD,
        legacy: true,
      });

      await recoverStaleScheduledActions(logger);

      expect(provider.calls).toEqual([]);
      await expect(
        getScheduledAction(scheduledActionId),
      ).resolves.toMatchObject({
        status: ScheduledActionStatus.FAILED,
        executedAction: {
          executionStatus: ExecutedActionStatus.FAILED,
          executionError: expect.objectContaining({
            code: "SEND_OUTCOME_UNKNOWN",
          }),
        },
      });
      await expectExecutedRuleStatus(executedRuleId, ExecutedRuleStatus.ERROR);
    });

    test("leaves an action that is still within its lease alone", async () => {
      const { scheduledActionId } = await seedScheduledAction({
        actionType: ActionType.ARCHIVE,
        executionStartedAt: new Date(Date.now() - 60_000),
      });

      const result = await recoverStaleScheduledActions(logger);

      expect(result.total).toBe(0);
      expect(provider.calls).toEqual([]);
      await expect(
        getScheduledAction(scheduledActionId),
      ).resolves.toMatchObject({ status: ScheduledActionStatus.EXECUTING });
    });

    test("gives up on an action whose runs keep dying", async () => {
      const { scheduledActionId, executedRuleId } = await seedScheduledAction({
        actionType: ActionType.LABEL,
        withExecutedAction: true,
        executionAttempts: 3,
      });

      await recoverStaleScheduledActions(logger);

      expect(provider.calls).toEqual([]);
      const row = await getScheduledAction(scheduledActionId);
      expect(row.status).toBe(ScheduledActionStatus.FAILED);
      expect(row.executedAction).toMatchObject({
        executionStatus: ExecutedActionStatus.FAILED,
        executionError: expect.objectContaining({
          code: "EXECUTION_INTERRUPTED",
        }),
      });
      await expectExecutedRuleStatus(executedRuleId, ExecutedRuleStatus.ERROR);
    });

    async function seedScheduledAction({
      actionType,
      status = ScheduledActionStatus.EXECUTING,
      withExecutedAction = false,
      executedActionStatus,
      executionStartedAt = STALE_START,
      executionAttempts = 1,
      legacy = false,
    }: {
      actionType: ActionType;
      status?: ScheduledActionStatus;
      withExecutedAction?: boolean;
      executedActionStatus?: ExecutedActionStatus;
      executionStartedAt?: Date;
      executionAttempts?: number;
      // Stuck by a build that recorded no lease and linked no executed action.
      legacy?: boolean;
    }) {
      const executedRule = await prisma.executedRule.create({
        data: {
          emailAccountId,
          threadId: "thread-1",
          messageId: "message-1",
          status: ExecutedRuleStatus.APPLYING,
          automated: true,
        },
      });
      const executedAction = withExecutedAction
        ? await prisma.executedAction.create({
            data: {
              executedRuleId: executedRule.id,
              type: actionType,
              executionStartedAt,
              executionStatus: executedActionStatus,
            },
          })
        : null;
      const scheduledAction = await prisma.scheduledAction.create({
        data: {
          executedRuleId: executedRule.id,
          emailAccountId,
          actionType,
          messageId: "message-1",
          threadId: "thread-1",
          scheduledFor: STALE_START,
          status,
          ...(status === ScheduledActionStatus.EXECUTING && !legacy
            ? { executionStartedAt, executionAttempts }
            : {}),
          executedActionId: executedAction?.id,
        },
      });
      if (legacy) {
        await prisma.$executeRaw`UPDATE "ScheduledAction" SET "updatedAt" = ${STALE_START} WHERE id = ${scheduledAction.id}`;
      }
      return {
        scheduledActionId: scheduledAction.id,
        executedRuleId: executedRule.id,
      };
    }

    function getScheduledAction(id: string) {
      return prisma.scheduledAction.findUniqueOrThrow({
        where: { id },
        include: { executedAction: true },
      });
    }

    async function expectExecutedRuleStatus(
      id: string,
      status: ExecutedRuleStatus,
    ) {
      await expect(
        prisma.executedRule.findUniqueOrThrow({ where: { id } }),
      ).resolves.toMatchObject({ status });
    }
  },
);

async function getProvider() {
  const { createEmailProvider } = await import("@/utils/email/provider");
  return createEmailProvider({
    emailAccountId: "unused",
    provider: "google",
    logger: undefined as never,
  });
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
  return emailAccount.id;
}
