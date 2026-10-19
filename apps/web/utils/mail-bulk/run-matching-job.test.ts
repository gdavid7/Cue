import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import type { MatchingFilter } from "@/utils/actions/mail-bulk-matching.validation";
import {
  GmailCallDeferredError,
  currentGmailQuotaContext,
} from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import {
  ACTIVE_MAIL_BULK_JOB_STATUSES,
  type MailBulkJobState,
  type MailBulkTarget,
  type mailBulkJobStore,
} from "@/utils/redis/mail-bulk-job";
import {
  MAIL_BULK_JOB_PATH,
  runMailBulkJobStep,
} from "@/utils/mail-bulk/run-matching-job";
import { publishToQstash, publishToQstashAt } from "@/utils/upstash";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/redis", () => ({ redis: {} }));
vi.mock("@/utils/upstash", () => ({
  publishToQstash: vi.fn().mockResolvedValue(undefined),
  publishToQstashAt: vi.fn().mockResolvedValue(true),
  hasDurableQstash: vi.fn(() => true),
}));

const logger = createScopedLogger("run-matching-job-test");
const JOB_ID = "00000000-0000-4000-8000-000000000001";
const UNDO_JOB_ID = "00000000-0000-4000-8000-000000000002";
const ACCOUNT_ID = "account-1";

describe("runMailBulkJobStep", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lists every page, then archives the targets in chunks", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({
      pages: [
        [message("m1", "t1"), message("m2", "t1")],
        [message("m3", "t2")],
      ],
    });

    const result = await runMailBulkJobStep({
      body: {
        jobId: JOB_ID,
        emailAccountId: ACCOUNT_ID,
        scope: {},
        deferrals: 0,
      },
      provider,
      ownerEmail: "owner@example.com",
      logger,
      store,
    });

    expect(result).toBe("done");
    expect(provider.listMatchingMessages).toHaveBeenCalledWith(
      expect.objectContaining({ only: { inInbox: true } }),
    );
    expect(provider.archiveMessages).toHaveBeenCalledWith(["m1", "m2", "m3"]);
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "done",
      total: 3,
      conversations: 2,
      applied: 3,
      failed: 0,
    });
  });

  it("only touches messages a read change would change", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "mark_read" }));
    const provider = createProvider({ pages: [[message("m1", "t1")]] });

    await runStep({ store, provider });

    expect(provider.listMatchingMessages).toHaveBeenCalledWith(
      expect.objectContaining({ only: { unread: true } }),
    );
    expect(provider.markMessagesReadState).toHaveBeenCalledWith(["m1"], true);
  });

  it("trashes and reports spam once per conversation", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "trash" }));
    const provider = createProvider({
      pages: [[message("m1", "t1"), message("m2", "t1"), message("m3", "t2")]],
    });

    await runStep({ store, provider });

    expect(provider.trashThread).toHaveBeenCalledTimes(2);
    expect(provider.trashThread).toHaveBeenCalledWith(
      "t1",
      "owner@example.com",
      "user",
    );
  });

  it("acts on the mailbox at background priority", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const priorities: string[] = [];
    const provider = createProvider({ pages: [[message("m1", "t1")]] });
    vi.mocked(provider.archiveMessages).mockImplementation(async () => {
      priorities.push(currentGmailQuotaContext().priority);
    });

    await runStep({ store, provider });

    expect(priorities).toEqual(["background"]);
  });

  it("hands the rest to a later delivery when its time runs out", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({
      pages: [[message("m1", "t1")], [message("m2", "t2")]],
    });
    let clock = 0;

    const result = await runMailBulkJobStep({
      body: {
        jobId: JOB_ID,
        emailAccountId: ACCOUNT_ID,
        scope: {},
        deferrals: 0,
      },
      provider,
      ownerEmail: "owner@example.com",
      logger,
      store,
      budgetMs: 10,
      now: () => {
        clock += 11;
        return clock;
      },
    });

    expect(result).toBe("continued");
    expect(publishToQstash).toHaveBeenCalledWith(
      MAIL_BULK_JOB_PATH,
      expect.objectContaining({ jobId: JOB_ID, pageToken: "page-1" }),
      expect.objectContaining({ key: `mail-bulk-${ACCOUNT_ID}` }),
    );
    expect(provider.archiveMessages).not.toHaveBeenCalled();
  });

  it("resumes from the same page once the Gmail quota gate's deferral passes", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({ pages: [[message("m1", "t1")], []] });
    vi.mocked(provider.listMatchingMessages)
      .mockResolvedValueOnce({
        messages: [message("m1", "t1")],
        nextPageToken: "page-1",
      })
      .mockRejectedValueOnce(new GmailCallDeferredError(5000, "background"));

    const result = await runStep({ store, provider });

    expect(result).toBe("deferred");
    expect(publishToQstashAt).toHaveBeenCalledWith(
      expect.objectContaining({
        path: MAIL_BULK_JOB_PATH,
        body: expect.objectContaining({ pageToken: "page-1", deferrals: 1 }),
      }),
    );
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "listing",
      total: 1,
    });
  });

  it("counts a chunk that fails and carries on", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "spam" }));
    const provider = createProvider({
      pages: [[message("m1", "t1"), message("m2", "t2")]],
    });
    vi.mocked(provider.markSpam).mockRejectedValueOnce(new Error("boom"));

    const result = await runStep({ store, provider });

    expect(result).toBe("done");
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      applied: 2,
      failed: 1,
    });
  });

  it("stops a cancelled job", async () => {
    const store = createStore();
    await store.create(
      JOB_ID,
      newJob({ action: "archive", status: "cancelled" }),
    );
    const provider = createProvider({ pages: [[message("m1", "t1")]] });

    await expect(runStep({ store, provider })).resolves.toBe("cancelled");
    expect(provider.listMatchingMessages).not.toHaveBeenCalled();
  });

  it("stops listing at the cap and says so", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({
      pages: [
        [message("m1", "t1"), message("m2", "t2")],
        [message("m3", "t3")],
      ],
    });

    await runMailBulkJobStep({
      body: {
        jobId: JOB_ID,
        emailAccountId: ACCOUNT_ID,
        scope: {},
        deferrals: 0,
      },
      provider,
      ownerEmail: "owner@example.com",
      logger,
      store,
      maxTargets: 2,
    });

    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "done",
      total: 2,
      capped: true,
    });
    expect(provider.listMatchingMessages).toHaveBeenCalledTimes(1);
  });

  it("undoes only what the source job had applied", async () => {
    const store = createStore();
    await store.create(
      JOB_ID,
      newJob({ action: "archive", status: "cancelled" }),
    );
    await store.appendTargets(JOB_ID, [
      { messageId: "m1", threadId: "t1" },
      { messageId: "m2", threadId: "t2" },
    ]);
    await store.increment(JOB_ID, "applied", 1);
    await store.create(
      UNDO_JOB_ID,
      newJob({ action: "unarchive", status: "applying", sourceJobId: JOB_ID }),
    );
    const provider = createProvider({ pages: [] });

    const result = await runMailBulkJobStep({
      body: { jobId: UNDO_JOB_ID, emailAccountId: ACCOUNT_ID, deferrals: 0 },
      provider,
      ownerEmail: "owner@example.com",
      logger,
      store,
    });

    expect(result).toBe("done");
    expect(provider.unarchiveMessages).toHaveBeenCalledWith(["m1"]);
    expect(provider.listMatchingMessages).not.toHaveBeenCalled();
  });

  it("ends the listing at the page a Stop lands on", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({
      pages: [[message("m1", "t1")], [message("m2", "t2")]],
    });
    vi.mocked(provider.listMatchingMessages).mockImplementationOnce(
      async () => {
        await stop(store, JOB_ID);
        return { messages: [message("m1", "t1")], nextPageToken: "page-1" };
      },
    );

    const result = await runStep({ store, provider });

    expect(result).toBe("cancelled");
    expect(provider.listMatchingMessages).toHaveBeenCalledTimes(1);
    expect(provider.archiveMessages).not.toHaveBeenCalled();
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "cancelled",
    });
  });

  it("finishes and counts the chunk in flight when Stop lands, then stops", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "trash" }));
    // Per-item chunks are 25 conversations, so this is two chunks.
    const page = Array.from({ length: 30 }, (_, index) =>
      message(`m${index}`, `t${index}`),
    );
    const provider = createProvider({ pages: [page] });
    vi.mocked(provider.trashThread).mockImplementationOnce(async () => {
      await stop(store, JOB_ID);
    });

    const result = await runStep({ store, provider });

    expect(result).toBe("cancelled");
    expect(provider.trashThread).toHaveBeenCalledTimes(25);
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "cancelled",
      applied: 25,
    });
  });

  it("settles a job asked to stop between deliveries", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ status: "stopping" }));
    const provider = createProvider({ pages: [[message("m1", "t1")]] });

    await expect(runStep({ store, provider })).resolves.toBe("cancelled");
    expect(provider.listMatchingMessages).not.toHaveBeenCalled();
  });

  it("saves progress after each small per-item chunk, so a cut-off delivery loses little", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "spam" }));
    const page = Array.from({ length: 60 }, (_, index) =>
      message(`m${index}`, `t${index}`),
    );
    const provider = createProvider({ pages: [page] });
    let clock = 0;

    // Time runs out after the first chunk.
    const result = await runStep({
      store,
      provider,
      budgetMs: 100,
      now: () => {
        clock += vi.mocked(provider.markSpam).mock.calls.length ? 100 : 1;
        return clock;
      },
    });

    expect(result).toBe("continued");
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "applying",
      applied: 25,
    });
  });

  it("labels each chunk with one batch call", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "label", labelId: "L1" }));
    const provider = createProvider({
      pages: [[message("m1", "t1"), message("m2", "t2")]],
    });

    await runStep({ store, provider });

    expect(provider.labelMessages).toHaveBeenCalledTimes(1);
    expect(provider.labelMessages).toHaveBeenCalledWith(["m1", "m2"], "L1");
  });

  it("without a durable scheduler, waits out a quota deferral in the same delivery", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({ pages: [[message("m1", "t1")]] });
    vi.mocked(provider.archiveMessages).mockRejectedValueOnce(
      new GmailCallDeferredError(5000, "background"),
    );
    const wait = vi.fn().mockResolvedValue(undefined);

    const result = await runStep({ store, provider, durable: false, wait });

    expect(result).toBe("done");
    expect(wait).toHaveBeenCalledWith(5000);
    expect(publishToQstashAt).not.toHaveBeenCalled();
    expect(provider.archiveMessages).toHaveBeenCalledTimes(2);
  });

  it("without a durable scheduler, fails rather than hang when a deferral outlasts the delivery", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({ pages: [[message("m1", "t1")]] });
    vi.mocked(provider.archiveMessages).mockRejectedValue(
      new GmailCallDeferredError(60_000, "background"),
    );

    const result = await runStep({
      store,
      provider,
      durable: false,
      budgetMs: 10_000,
    });

    expect(result).toBe("failed");
    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "failed",
    });
  });

  it("without a durable scheduler, caps the job to what one delivery can do", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "trash" }));
    const page = Array.from({ length: 1500 }, (_, index) =>
      message(`m${index}`, `t${index}`),
    );
    const provider = createProvider({ pages: [page, [message("x", "y")]] });

    await runStep({ store, provider, durable: false });

    await expect(store.get(JOB_ID)).resolves.toMatchObject({
      status: "done",
      total: 1000,
      capped: true,
    });
  });

  it("an undo pressed mid-chunk also restores the chunk in flight", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({
      pages: [[message("m1", "t1"), message("m2", "t2")]],
    });
    let undoRun: ReturnType<typeof runMailBulkJobStep> | undefined;
    vi.mocked(provider.archiveMessages).mockImplementationOnce(async () => {
      // Undo is pressed while this chunk is with the provider, in the order
      // undoMatchingBulkActionAction takes: ask the source to stop, then
      // create the undo job and deliver it.
      await stop(store, JOB_ID);
      await store.create(
        UNDO_JOB_ID,
        newJob({
          action: "unarchive",
          status: "applying",
          sourceJobId: JOB_ID,
        }),
      );
      undoRun = runMailBulkJobStep({
        body: { jobId: UNDO_JOB_ID, emailAccountId: ACCOUNT_ID, deferrals: 0 },
        provider,
        ownerEmail: "owner@example.com",
        logger,
        store,
        durable: true,
        wait: () => new Promise((resolve) => setTimeout(resolve, 1)),
      });
      // The undo is now waiting while the chunk is still in flight.
      await new Promise((resolve) => setTimeout(resolve, 10));
    });
    const sourceStatusAtUndo: string[] = [];
    vi.mocked(provider.unarchiveMessages).mockImplementation(async () => {
      sourceStatusAtUndo.push((await store.get(JOB_ID))?.status ?? "");
    });

    const sourceResult = await runStep({ store, provider });

    expect(sourceResult).toBe("cancelled");
    await expect(undoRun).resolves.toBe("done");
    expect(provider.unarchiveMessages).toHaveBeenCalledWith(["m1", "m2"]);
    expect(sourceStatusAtUndo).toEqual(["cancelled"]);
    await expect(store.get(JOB_ID)).resolves.toMatchObject({ applied: 2 });
  });

  it("ignores a delivery for another account's job", async () => {
    const store = createStore();
    await store.create(JOB_ID, newJob({ action: "archive" }));
    const provider = createProvider({ pages: [[message("m1", "t1")]] });

    const result = await runMailBulkJobStep({
      body: { jobId: JOB_ID, emailAccountId: "other", scope: {}, deferrals: 0 },
      provider,
      ownerEmail: "owner@example.com",
      logger,
      store,
    });

    expect(result).toBe("missing");
    expect(provider.listMatchingMessages).not.toHaveBeenCalled();
  });
});

function runStep({
  store,
  provider,
  ...options
}: {
  store: ReturnType<typeof createStore>;
  provider: EmailProvider;
} & Partial<Parameters<typeof runMailBulkJobStep>[0]>) {
  return runMailBulkJobStep({
    body: {
      jobId: JOB_ID,
      emailAccountId: ACCOUNT_ID,
      scope: {},
      deferrals: 0,
    },
    provider,
    ownerEmail: "owner@example.com",
    logger,
    store,
    durable: true,
    ...options,
  });
}

// What the Stop and Undo actions do to the job they end.
function stop(store: ReturnType<typeof createStore>, jobId: string) {
  return store.transition(jobId, ACTIVE_MAIL_BULK_JOB_STATUSES, "stopping");
}

function message(id: string, threadId: string) {
  return { id, threadId };
}

function newJob(overrides: Partial<MailBulkJobState>): MailBulkJobState {
  return {
    emailAccountId: ACCOUNT_ID,
    action: "archive",
    status: "listing",
    total: 0,
    conversations: 0,
    applied: 0,
    failed: 0,
    capped: false,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function createProvider({
  pages,
}: {
  pages: { id: string; threadId: string }[][];
}) {
  const listMatchingMessages = vi.fn(
    async ({ pageToken }: { only: MatchingFilter; pageToken?: string }) => {
      const index = pageToken ? Number(pageToken.split("-")[1]) : 0;
      return {
        messages: pages[index] ?? [],
        nextPageToken:
          index + 1 < pages.length ? `page-${index + 1}` : undefined,
      };
    },
  );
  return {
    name: "google",
    listMatchingMessages,
    archiveMessages: vi.fn().mockResolvedValue(undefined),
    unarchiveMessages: vi.fn().mockResolvedValue(undefined),
    markMessagesReadState: vi.fn().mockResolvedValue(undefined),
    labelMessages: vi.fn().mockResolvedValue(undefined),
    trashThread: vi.fn().mockResolvedValue(undefined),
    markSpam: vi.fn().mockResolvedValue(undefined),
  } as unknown as EmailProvider;
}

function createStore(): typeof mailBulkJobStore {
  const jobs = new Map<string, MailBulkJobState>();
  const targets = new Map<string, MailBulkTarget[]>();
  const conversations = new Map<string, Set<string>>();
  return {
    async create(jobId, state) {
      jobs.set(jobId, { ...state });
    },
    async get(jobId) {
      const job = jobs.get(jobId);
      return job ? { ...job } : null;
    },
    async setCapped(jobId) {
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, capped: true });
    },
    async transition(jobId, from, to) {
      const job = jobs.get(jobId);
      if (!job || !from.includes(job.status)) return false;
      jobs.set(jobId, { ...job, status: to });
      return true;
    },
    async increment(jobId, field, by) {
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, [field]: job[field] + by });
    },
    async appendTargets(jobId, added) {
      targets.set(jobId, [...(targets.get(jobId) ?? []), ...added]);
      const seen = conversations.get(jobId) ?? new Set<string>();
      const before = seen.size;
      for (const target of added) seen.add(target.threadId);
      conversations.set(jobId, seen);
      return seen.size - before;
    },
    async readTargets(jobId, start, count) {
      return (targets.get(jobId) ?? []).slice(start, start + count);
    },
  };
}
