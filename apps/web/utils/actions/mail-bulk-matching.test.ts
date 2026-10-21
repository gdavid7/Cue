import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  cancelMatchingBulkActionAction,
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
  ACTIVE_MAIL_BULK_JOB_STATUSES: ["listing", "applying"],
  mailBulkJobStore: {
    create: async (jobId: string, state: MailBulkJobState) => {
      jobs.set(jobId, state);
    },
    get: async (jobId: string) => jobs.get(jobId) ?? null,
    transition: async (
      jobId: string,
      from: MailBulkJobState["status"][],
      to: MailBulkJobState["status"],
    ) => {
      const job = jobs.get(jobId);
      if (!job || !from.includes(job.status)) return false;
      jobs.set(jobId, { ...job, status: to });
      return true;
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
    expect(prisma.mailBulkJobListing.create).toHaveBeenCalledWith({
      data: { jobId, emailAccountId: "account-1", scope: { type: "inbox" } },
    });
    expect(mockEnqueue).toHaveBeenCalledWith({
      jobId,
      emailAccountId: "account-1",
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

  it.each([
    { type: "trash", folderId: "inbox" },
    { type: "trash", labelIds: ["INBOX"] },
    { type: "trash", q: "in:inbox" },
    { type: "inbox" },
  ])("lists only the trash to delete forever, whatever the scope says (%o)", async (scope) => {
    mockCreateEmailProvider.mockResolvedValue({
      deleteMessagesForever: vi.fn(),
    });

    const result = await startMatchingBulkActionAction("account-1", {
      scope,
      action: "delete_forever",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.mailBulkJobListing.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ scope: { type: "trash" } }),
    });
    expect(mockEnqueue).toHaveBeenCalled();
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
    expect(jobs.get(SOURCE_JOB_ID)?.status).toBe("stopping");
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

  it("Stop asks a running job to stop and leaves a finished one alone", async () => {
    jobs.set(SOURCE_JOB_ID, sourceJob({ status: "applying" }));
    await cancelMatchingBulkActionAction("account-1", { jobId: SOURCE_JOB_ID });
    // The delivery marks it cancelled once its chunk in flight is counted.
    expect(jobs.get(SOURCE_JOB_ID)?.status).toBe("stopping");

    jobs.set(SOURCE_JOB_ID, sourceJob({ status: "done" }));
    await cancelMatchingBulkActionAction("account-1", { jobId: SOURCE_JOB_ID });
    expect(jobs.get(SOURCE_JOB_ID)?.status).toBe("done");
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
    updatedAt: 0,
    ...overrides,
  };
}
