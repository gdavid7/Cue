import { beforeEach, describe, expect, it, vi } from "vitest";
import { CleanAction } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { queueCleanInboxThreads } from "@/app/api/clean/queue-inbox";
import { POST } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal: (handler: unknown) => handler,
}));
vi.mock("@/utils/cleaner-feature", () => ({
  assertCleanerApiEnabled: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn().mockResolvedValue({ name: "google" }),
}));
vi.mock("@/app/api/clean/queue-inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/app/api/clean/queue-inbox")>()),
  queueCleanInboxThreads: vi.fn(),
}));

const job = {
  emailAccountId: "account-1",
  jobId: "job-1",
  action: CleanAction.ARCHIVE,
  instructions: "",
  skips: { reply: true, starred: true },
  markedDoneLabelId: "done-label",
  processedLabelId: "processed-label",
  labelType: "inbox",
  pageToken: "p2",
  queuedCount: 100,
  deferrals: 2,
};

describe("clean job resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes the job from the page it stopped at", async () => {
    prisma.cleanupJob.findFirst.mockResolvedValue({ id: "job-1" } as never);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(queueCleanInboxThreads).toHaveBeenCalledWith(
      expect.objectContaining({
        jobId: "job-1",
        pageToken: "p2",
        queuedCount: 100,
        deferrals: 2,
      }),
    );
  });

  it("does nothing once the job is gone", async () => {
    prisma.cleanupJob.findFirst.mockResolvedValue(null);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(queueCleanInboxThreads).not.toHaveBeenCalled();
  });
});

function resume() {
  return new Request("http://localhost/api/clean/resume", {
    method: "POST",
    body: JSON.stringify(job),
  }) as never;
}
