import { beforeEach, describe, expect, it, vi } from "vitest";
import { CleanAction } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import { queueCleanInboxThreads } from "@/app/api/clean/queue-inbox";
import { isCleanerApiEnabled } from "@/utils/cleaner-feature";
import { POST } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});
// Stands in for QStash signature or internal key verification.
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal:
    (handler: (...args: unknown[]) => unknown) =>
    (request: Request, ...rest: unknown[]) =>
      request.headers.get("x-test-verified")
        ? handler(request, ...rest)
        : new Response("Unauthorized", { status: 401 }),
}));
vi.mock("@/utils/cleaner-feature", () => ({
  isCleanerApiEnabled: vi.fn(),
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
    vi.mocked(isCleanerApiEnabled).mockReturnValue(true);
    prisma.cleanupJob.findFirst.mockResolvedValue({ id: "job-1" } as never);
  });

  it("resumes the job from the page it stopped at", async () => {
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

  it("acknowledges the delivery without resuming once the cleaner is off", async () => {
    vi.mocked(isCleanerApiEnabled).mockReturnValue(false);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(queueCleanInboxThreads).not.toHaveBeenCalled();
  });

  it("refuses a request that is neither signed nor internal", async () => {
    const response = await POST(resume({ verified: false }), {} as never);

    expect(response.status).toBe(401);
    expect(queueCleanInboxThreads).not.toHaveBeenCalled();
  });
});

function resume({ verified = true } = {}) {
  return new Request("http://localhost/api/clean/resume", {
    method: "POST",
    headers: verified ? { "x-test-verified": "1" } : {},
    body: JSON.stringify(job),
  }) as never;
}
