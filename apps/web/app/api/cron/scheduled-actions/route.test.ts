import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@/utils/logger";

const mocks = vi.hoisted(() => ({
  logger: undefined as Logger | undefined,
  findScheduledActions: vi.fn(),
  processDueSnoozedThreads: vi.fn(),
  processDueScheduledEmails: vi.fn(),
  recordFirstHourHealth: vi.fn(),
  markQStashActionAsExecuting: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: { CRON_SECRET: "cron-secret", QSTASH_TOKEN: undefined },
}));
vi.mock("@/utils/error", () => ({ captureException: vi.fn() }));
vi.mock("@/utils/prisma", () => ({
  default: { scheduledAction: { findMany: mocks.findScheduledActions } },
}));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/scheduled-actions/executor", () => ({
  checkAndCompleteExecutedRule: vi.fn(),
  executeScheduledAction: vi.fn(),
}));
vi.mock("@/utils/scheduled-actions/scheduler", () => ({
  markQStashActionAsExecuting: mocks.markQStashActionAsExecuting,
}));
vi.mock("@/utils/snooze/process-due", () => ({
  processDueSnoozedThreads: mocks.processDueSnoozedThreads,
}));
vi.mock("@/utils/scheduled-email/service", () => ({
  processDueScheduledEmails: mocks.processDueScheduledEmails,
}));
vi.mock("@/utils/analytics/first-hour-health", () => ({
  recordFirstHourHealthForNewMailboxes: mocks.recordFirstHourHealth,
}));
vi.mock("@/utils/middleware", async () => {
  const { createTestLogger, createWithErrorTestMiddleware } =
    await vi.importActual<typeof import("@/__tests__/helpers")>(
      "@/__tests__/helpers",
    );
  mocks.logger = createTestLogger();
  return createWithErrorTestMiddleware({ logger: mocks.logger });
});

import { runWithRequestDeadline } from "@/utils/request-deadline";
import { GET } from "./route";

describe("scheduled actions cron route", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mocks.findScheduledActions.mockResolvedValue([]);
    mocks.processDueSnoozedThreads.mockResolvedValue({
      processed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
    });
    mocks.processDueScheduledEmails.mockResolvedValue({ processed: 0 });
    mocks.recordFirstHourHealth.mockResolvedValue({
      candidates: 3,
      unsent: 2,
      sent: 2,
      failed: 0,
    });
  });

  it("logs a finished line with the first-hour health counts on a run with nothing due", async () => {
    const info = vi.spyOn(mocks.logger!, "info");

    const response = await GET(
      new Request("http://localhost:3000/api/cron/scheduled-actions", {
        headers: { authorization: "Bearer cron-secret" },
      }) as never,
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    const finished = info.mock.calls.filter(
      ([message]) => message === "Cron finished",
    );
    expect(finished).toHaveLength(1);
    expect(finished[0][1]).toMatchObject({
      durationMs: expect.any(Number),
      scheduledActions: { processed: 0, failed: 0, total: 0 },
      firstHourHealth: { candidates: 3, sent: 2, failed: 0 },
    });
  });

  it("stops before the route's deadline and leaves the rest pending", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(mocks.logger!, "warn");
    mocks.findScheduledActions.mockResolvedValue(
      ["action-1", "action-2", "action-3"].map((id) => ({
        id,
        emailAccountId: "email-account-1",
        executedRuleId: "executed-rule-1",
        emailAccount: { account: { provider: "google" } },
      })),
    );
    // The first action takes most of the route's five minutes, and another
    // run already claimed it.
    mocks.markQStashActionAsExecuting.mockImplementationOnce(async () => {
      vi.advanceTimersByTime(270_000);
      return null;
    });

    const response = await runWithRequestDeadline(300, () =>
      GET(
        new Request("http://localhost:3000/api/cron/scheduled-actions", {
          headers: { authorization: "Bearer cron-secret" },
        }) as never,
        { params: Promise.resolve({}) },
      ),
    );
    vi.useRealTimers();

    expect(mocks.markQStashActionAsExecuting).toHaveBeenCalledTimes(1);
    expect((await response.json()).scheduledActions).toEqual({
      processed: 0,
      failed: 0,
      skipped: 1,
      left: 2,
      total: 3,
    });
    expect(warn).toHaveBeenCalledWith(
      "Stopping scheduled actions before the deadline",
      { left: 2 },
    );
  });
});
