import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";

const mockSend = vi.fn();
const mockPublishToQstashQueue = vi.fn();
const mockPublishToInternalApiInBackground = vi.fn();
const mockEnqueueBullmqHttpJob = vi.fn();
const mockIsVercelQueueDispatchEnabled = vi.fn();

async function loadDispatchModule({
  queueBackend,
  qstashToken,
  redisUrl,
}: {
  queueBackend?: "bullmq" | "internal" | "qstash";
  qstashToken?: string;
  redisUrl?: string;
}) {
  vi.resetModules();
  vi.clearAllMocks();

  vi.doMock("@vercel/queue", () => ({
    send: mockSend,
  }));

  vi.doMock("@/env", () => ({
    env: {
      QUEUE_BACKEND: queueBackend,
      QSTASH_TOKEN: qstashToken,
      REDIS_URL: redisUrl,
    },
  }));

  vi.doMock("@/utils/upstash", () => ({
    publishToInternalApiInBackground: mockPublishToInternalApiInBackground,
    publishToQstashQueue: mockPublishToQstashQueue,
  }));

  vi.doMock("@/utils/queue/bullmq", () => ({
    enqueueBullmqHttpJob: mockEnqueueBullmqHttpJob,
  }));

  vi.doMock("@/utils/queue/vercel", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/utils/queue/vercel")>()),
    isVercelQueueDispatchEnabled: mockIsVercelQueueDispatchEnabled,
  }));

  return import("./dispatch");
}

describe("enqueueBackgroundJob", () => {
  beforeEach(() => {
    mockPublishToInternalApiInBackground.mockReset();
    mockIsVercelQueueDispatchEnabled.mockReturnValue(false);
  });

  it("uses BullMQ when configured", async () => {
    const { enqueueBackgroundJob } = await loadDispatchModule({
      queueBackend: "bullmq",
      redisUrl: "redis://localhost:6379",
    });

    const result = await enqueueBackgroundJob({
      topic: "topic",
      body: { id: "job-1" },
      qstash: {
        queueName: "automation-jobs",
        parallelism: 3,
        path: "/api/automation-jobs/execute",
      },
      logger: createTestLogger(),
    });

    expect(result).toBe("bullmq");
    expect(mockEnqueueBullmqHttpJob).toHaveBeenCalledWith({
      queueName: "automation-jobs",
      path: "/api/automation-jobs/execute",
      body: { id: "job-1" },
      headers: undefined,
    });
    expect(mockPublishToQstashQueue).not.toHaveBeenCalled();
  });

  it("falls back to QStash when BullMQ is selected without Redis", async () => {
    const { enqueueBackgroundJob } = await loadDispatchModule({
      queueBackend: "bullmq",
      qstashToken: "qstash-token",
      redisUrl: undefined,
    });

    mockPublishToQstashQueue.mockResolvedValue(undefined);

    const result = await enqueueBackgroundJob({
      topic: "topic",
      body: { id: "job-2" },
      qstash: {
        queueName: "automation-jobs",
        parallelism: 3,
        path: "/api/automation-jobs/execute",
      },
      logger: createTestLogger(),
    });

    expect(result).toBe("qstash");
    expect(mockPublishToQstashQueue).toHaveBeenCalled();
  });

  it("keeps the existing QStash path when configured", async () => {
    const { enqueueBackgroundJob } = await loadDispatchModule({
      queueBackend: "qstash",
      qstashToken: "qstash-token",
    });

    mockPublishToQstashQueue.mockResolvedValue(undefined);

    const result = await enqueueBackgroundJob({
      topic: "topic",
      body: { id: "job-3" },
      qstash: {
        queueName: "email-digest-all",
        parallelism: 3,
        path: "/api/resend/digest",
        deduplicationId: "digest-account-1-2026-06-16",
      },
      logger: createTestLogger(),
    });

    expect(result).toBe("qstash");
    expect(mockPublishToQstashQueue).toHaveBeenCalledWith({
      queueName: "email-digest-all",
      parallelism: 3,
      path: "/api/resend/digest",
      body: { id: "job-3" },
      headers: undefined,
      deduplicationId: "digest-account-1-2026-06-16",
    });
    expect(mockEnqueueBullmqHttpJob).not.toHaveBeenCalled();
  });

  it("honors the internal backend even when QStash is configured", async () => {
    const { enqueueBackgroundJob } = await loadDispatchModule({
      queueBackend: "internal",
      qstashToken: "qstash-token",
    });

    mockPublishToInternalApiInBackground.mockResolvedValue(undefined);

    const result = await enqueueBackgroundJob({
      topic: "topic",
      body: { id: "job-4" },
      qstash: {
        queueName: "email-digest-all",
        parallelism: 3,
        path: "/api/resend/digest",
      },
      logger: createTestLogger(),
    });

    expect(result).toBe("internal-fallback");
    expect(mockPublishToInternalApiInBackground).toHaveBeenCalledWith({
      path: "/api/resend/digest",
      body: { id: "job-4" },
      headers: undefined,
    });
    expect(mockPublishToQstashQueue).not.toHaveBeenCalled();
  });

  it("on Vercel, sends topics whose queue consumer is deployed", async () => {
    const { enqueueBackgroundJob } = await loadDispatchModule({
      queueBackend: "qstash",
      qstashToken: "qstash-token",
    });
    mockIsVercelQueueDispatchEnabled.mockReturnValue(true);
    mockSend.mockResolvedValue(undefined);

    const result = await enqueueBackgroundJob({
      topic: "ai-digest",
      body: { id: "job-5" },
      qstash: {
        queueName: "ai-digest",
        parallelism: 3,
        path: "/api/ai/digest",
      },
      logger: createTestLogger(),
    });

    expect(result).toBe("vercel");
    expect(mockSend).toHaveBeenCalledWith(
      "ai-digest",
      { id: "job-5" },
      {
        delaySeconds: undefined,
      },
    );
  });

  it("on Vercel, skips topics whose queue consumer is not deployed", async () => {
    const { enqueueBackgroundJob } = await loadDispatchModule({
      queueBackend: "qstash",
      qstashToken: "qstash-token",
    });
    mockIsVercelQueueDispatchEnabled.mockReturnValue(true);

    const result = await enqueueBackgroundJob({
      topic: "resend-digest",
      body: { id: "job-6" },
      qstash: {
        queueName: "email-digest-all",
        parallelism: 3,
        path: "/api/resend/digest",
      },
      logger: createTestLogger(),
    });

    expect(result).toBe("skipped");
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPublishToQstashQueue).not.toHaveBeenCalled();
    expect(mockPublishToInternalApiInBackground).not.toHaveBeenCalled();
    expect(mockEnqueueBullmqHttpJob).not.toHaveBeenCalled();
  });
});
