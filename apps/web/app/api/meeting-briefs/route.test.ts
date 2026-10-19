import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  captureExceptionMock,
  envMock,
  mockPrisma,
  processUserMeetingBriefingsMock,
} = vi.hoisted(() => ({
  captureExceptionMock: vi.fn(),
  envMock: {
    CRON_SECRET: "cron-secret",
  },
  mockPrisma: {
    emailAccount: {
      findMany: vi.fn(),
    },
  },
  processUserMeetingBriefingsMock: vi.fn(),
}));

vi.mock("@/env", () => ({
  env: envMock,
}));

vi.mock("@/utils/error", () => ({
  captureException: (...args: unknown[]) => captureExceptionMock(...args),
}));

vi.mock("@/utils/prisma", () => ({
  default: mockPrisma,
}));

vi.mock("@/utils/premium", () => ({
  getPremiumUserFilter: vi.fn(() => ({})),
}));

vi.mock("@/utils/meeting-briefs/process", () => ({
  processUserMeetingBriefings: (...args: unknown[]) =>
    processUserMeetingBriefingsMock(...args),
}));

vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithErrorTestMiddleware();
});

import { GET } from "./route";

describe("meeting briefs cron route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    envMock.CRON_SECRET = "cron-secret";
  });

  it("processes each user's mailboxes together with bounded concurrency", async () => {
    // Seven users; the first has two mailboxes, so eight accounts in all.
    mockPrisma.emailAccount.findMany.mockResolvedValue([
      {
        id: "email-account-0",
        userId: "user-1",
        email: "account-0@example.test",
        meetingBriefingsMinutesBefore: 60,
      },
      ...Array.from({ length: 7 }, (_, index) => ({
        id: `email-account-${index + 1}`,
        userId: `user-${index + 1}`,
        email: `account-${index + 1}@example.test`,
        meetingBriefingsMinutesBefore: 60,
      })),
    ]);

    let active = 0;
    let maxActive = 0;
    processUserMeetingBriefingsMock.mockImplementation(
      async ({
        userId,
        emailAccounts,
      }: {
        userId: string;
        emailAccounts: { id: string }[];
      }) => {
        active++;
        maxActive = Math.max(maxActive, active);

        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;

        if (userId === "user-3") throw new Error("Processing failed");
        return emailAccounts.map((account) =>
          account.id === "email-account-0"
            ? { emailAccountId: account.id, error: new Error("Fetch failed") }
            : { emailAccountId: account.id },
        );
      },
    );

    const response = await GET(
      new Request("http://localhost:3000/api/meeting-briefs", {
        headers: { authorization: "Bearer cron-secret" },
      }),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      total: 8,
      success: 6,
      errors: 2,
    });
    expect(processUserMeetingBriefingsMock).toHaveBeenCalledTimes(7);
    expect(processUserMeetingBriefingsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-1",
        emailAccounts: [
          expect.objectContaining({ id: "email-account-0" }),
          expect.objectContaining({ id: "email-account-1" }),
        ],
      }),
    );
    expect(maxActive).toBe(5);
    expect(captureExceptionMock).toHaveBeenCalledTimes(2);
  });
});
