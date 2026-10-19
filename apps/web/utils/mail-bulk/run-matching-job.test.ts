import { beforeEach, describe, expect, it, vi } from "vitest";
import type { EmailProvider } from "@/utils/email/types";
import type { MatchingFilter } from "@/utils/actions/mail-bulk-matching.validation";
import {
  GmailCallDeferredError,
  currentGmailQuotaContext,
} from "@/utils/gmail/quota";
import { createScopedLogger } from "@/utils/logger";
import type {
  MailBulkJobState,
  MailBulkTarget,
  mailBulkJobStore,
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
}: {
  store: ReturnType<typeof createStore>;
  provider: EmailProvider;
}) {
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
  });
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
    labelMessage: vi.fn().mockResolvedValue({}),
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
    async update(jobId, fields) {
      const job = jobs.get(jobId);
      if (job) jobs.set(jobId, { ...job, ...fields });
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
