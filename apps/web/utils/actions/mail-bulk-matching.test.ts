import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  startMatchingBulkActionAction,
  undoMatchingBulkActionAction,
} from "@/utils/actions/mail-bulk-matching";
import type { MailBulkJobState } from "@/utils/redis/mail-bulk-job";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const { jobs, mockEnqueue, mockCreateEmailProvider } = vi.hoisted(() => ({
  jobs: new Map<string, MailBulkJobState>(),
  mockEnqueue: vi.fn(),
  mockCreateEmailProvider: vi.fn(),
}));

vi.mock("@/env", () => ({ env: { NODE_ENV: "test" } }));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: (...args: unknown[]) => mockCreateEmailProvider(...args),
}));
vi.mock("@/utils/mail-bulk/run-matching-job", () => ({
  enqueueMailBulkJob: (...args: unknown[]) => mockEnqueue(...args),
}));
vi.mock("@/utils/redis/mail-bulk-job", () => ({
  mailBulkJobStore: {
    create: async (jobId: string, state: MailBulkJobState) => {
      jobs.set(jobId, state);
    },
    get: async (jobId: string) => jobs.get(jobId) ?? null,
    update: async (jobId: string, fields: Partial<MailBulkJobState>) => {
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, ...fields });
    },
  },
}));

const SOURCE_JOB_ID = "00000000-0000-4000-8000-000000000001";

describe("mail bulk matching actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    jobs.clear();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "owner@example.com",
        userId: "user-1",
        provider: "google",
      }),
    );
  });

  it("starts a job for the view and queues its first delivery", async () => {
    const result = await startMatchingBulkActionAction("account-1", {
      scope: { type: "inbox" },
      action: "archive",
    });

    const jobId = result?.data?.jobId;
    expect(jobId).toBeDefined();
    expect(jobs.get(jobId as string)).toMatchObject({
      emailAccountId: "account-1",
      action: "archive",
      status: "listing",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      jobId,
      emailAccountId: "account-1",
      scope: { type: "inbox" },
      deferrals: 0,
    });
  });

  it("refuses to delete forever where the provider can't", async () => {
    mockCreateEmailProvider.mockResolvedValue({});

    const result = await startMatchingBulkActionAction("account-1", {
      scope: { type: "trash" },
      action: "delete_forever",
    });

    expect(result?.serverError).toMatch(/can't be deleted forever/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("only deletes forever from the trash", async () => {
    mockCreateEmailProvider.mockResolvedValue({
      deleteMessagesForever: vi.fn(),
    });

    const result = await startMatchingBulkActionAction("account-1", {
      scope: { type: "inbox" },
      action: "delete_forever",
    });

    expect(result?.serverError).toMatch(/trash/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it("undoes an archive by stopping it and restoring what it moved", async () => {
    jobs.set(
      SOURCE_JOB_ID,
      sourceJob({ action: "archive", status: "applying" }),
    );

    const result = await undoMatchingBulkActionAction("account-1", {
      jobId: SOURCE_JOB_ID,
    });

    const undoJobId = result?.data?.jobId as string;
    expect(jobs.get(SOURCE_JOB_ID)?.status).toBe("cancelled");
    expect(jobs.get(undoJobId)).toMatchObject({
      action: "unarchive",
      sourceJobId: SOURCE_JOB_ID,
      status: "applying",
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      jobId: undoJobId,
      emailAccountId: "account-1",
      deferrals: 0,
    });
  });

  it("won't undo another account's job or an irreversible one", async () => {
    jobs.set(SOURCE_JOB_ID, sourceJob({ emailAccountId: "account-2" }));
    const foreign = await undoMatchingBulkActionAction("account-1", {
      jobId: SOURCE_JOB_ID,
    });
    expect(foreign?.serverError).toBeDefined();

    jobs.set(SOURCE_JOB_ID, sourceJob({ action: "trash" }));
    const trash = await undoMatchingBulkActionAction("account-1", {
      jobId: SOURCE_JOB_ID,
    });
    expect(trash?.serverError).toBeDefined();
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

function sourceJob(overrides: Partial<MailBulkJobState>): MailBulkJobState {
  return {
    emailAccountId: "account-1",
    action: "archive",
    status: "done",
    total: 10,
    conversations: 5,
    applied: 10,
    failed: 0,
    capped: false,
    ...overrides,
  };
}
