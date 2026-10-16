import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { CleanAction } from "@/generated/prisma/enums";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { bulkPublishToQstash, publishToQstashAt } from "@/utils/upstash";
import {
  CLEAN_INBOX_RESUME_PATH,
  type CleanInboxQueueBody,
  queueCleanInboxThreads,
} from "./queue-inbox";

vi.mock("@/utils/upstash", () => ({
  bulkPublishToQstash: vi.fn(),
  publishToQstashAt: vi.fn().mockResolvedValue(true),
}));

const logger = createTestLogger();
const getThreadsWithQuery = vi.fn();
const getLabelById = vi.fn();
const emailProvider = { getThreadsWithQuery, getLabelById } as never;

const job: CleanInboxQueueBody = {
  emailAccountId: "account-1",
  jobId: "job-1",
  action: CleanAction.ARCHIVE,
  instructions: "",
  skips: { reply: true, starred: true },
  markedDoneLabelId: "done-label",
  processedLabelId: "processed-label",
  maxEmails: 10,
  before: 1_700_000_000_000,
  queuedCount: 0,
  deferrals: 0,
};

describe("queueCleanInboxThreads", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLabelById.mockResolvedValue({ threadsTotal: 50 });
  });

  it("reads each page after the last instead of the first page again", async () => {
    getThreadsWithQuery
      .mockResolvedValueOnce({ threads: [{ id: "t1" }], nextPageToken: "p2" })
      .mockResolvedValueOnce({ threads: [{ id: "t2" }] });

    await queueCleanInboxThreads({ ...job, emailProvider, logger });

    expect(
      getThreadsWithQuery.mock.calls.map(([options]) => options.pageToken),
    ).toEqual([undefined, "p2"]);
    expect(queuedThreadIds()).toEqual(["t1", "t2"]);
  });

  it("schedules the rest of the job from the page the Gmail quota gate deferred", async () => {
    getThreadsWithQuery
      .mockResolvedValueOnce({ threads: [{ id: "t1" }], nextPageToken: "p2" })
      .mockRejectedValueOnce(new GmailCallDeferredError(20_000, "background"));
    const before = Date.now();

    await queueCleanInboxThreads({ ...job, emailProvider, logger });

    expect(queuedThreadIds()).toEqual(["t1"]);
    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    const [{ path, body, notBefore }] =
      vi.mocked(publishToQstashAt).mock.calls[0];
    expect(path).toBe(CLEAN_INBOX_RESUME_PATH);
    expect(body).toEqual({
      ...job,
      labelType: "inbox",
      pageToken: "p2",
      queuedCount: 1,
      deferrals: 1,
    });
    expect(notBefore.getTime()).toBeGreaterThanOrEqual(before + 20_000);
  });

  it("resumes from the deferred page with the job's original filters", async () => {
    getThreadsWithQuery.mockResolvedValueOnce({ threads: [{ id: "t2" }] });

    await queueCleanInboxThreads({
      ...job,
      labelType: "unread",
      pageToken: "p2",
      queuedCount: 1,
      deferrals: 1,
      emailProvider,
      logger,
    });

    expect(getLabelById).not.toHaveBeenCalled();
    const [options] = getThreadsWithQuery.mock.calls[0];
    expect(options.pageToken).toBe("p2");
    expect(options.query.before).toEqual(new Date(job.before as number));
    expect(options.query.labelIds).toEqual(["INBOX", "UNREAD"]);
    expect(queuedThreadIds()).toEqual(["t2"]);
  });

  it("publishes each thread once per job even if a page is read twice", async () => {
    getThreadsWithQuery.mockResolvedValueOnce({
      threads: [{ id: "t1" }, { id: "t2" }],
    });

    await queueCleanInboxThreads({ ...job, emailProvider, logger });

    const [{ items }] = vi.mocked(bulkPublishToQstash).mock.calls[0];
    expect(items.map((item) => item.deduplicationId)).toEqual([
      "clean-job-1-t1",
      "clean-job-1-t2",
    ]);
  });

  it("gives up after five deferrals in a row without progress", async () => {
    getThreadsWithQuery.mockRejectedValue(
      new GmailCallDeferredError(20_000, "background"),
    );

    await queueCleanInboxThreads({
      ...job,
      labelType: "inbox",
      deferrals: 5,
      emailProvider,
      logger,
    });

    expect(publishToQstashAt).not.toHaveBeenCalled();
  });

  it("starts the deferral count over once a run queued more threads", async () => {
    getThreadsWithQuery
      .mockResolvedValueOnce({ threads: [{ id: "t2" }], nextPageToken: "p3" })
      .mockRejectedValueOnce(new GmailCallDeferredError(20_000, "background"));

    await queueCleanInboxThreads({
      ...job,
      labelType: "inbox",
      pageToken: "p2",
      queuedCount: 1,
      deferrals: 5,
      emailProvider,
      logger,
    });

    expect(publishToQstashAt).toHaveBeenCalledTimes(1);
    expect(vi.mocked(publishToQstashAt).mock.calls[0][0].body).toMatchObject({
      pageToken: "p3",
      queuedCount: 2,
      deferrals: 1,
    });
  });

  it("does not collapse a resume after progress into an earlier one", async () => {
    getThreadsWithQuery.mockRejectedValueOnce(
      new GmailCallDeferredError(20_000, "background"),
    );
    await queueCleanInboxThreads({
      ...job,
      labelType: "inbox",
      emailProvider,
      logger,
    });

    getThreadsWithQuery
      .mockResolvedValueOnce({ threads: [{ id: "t1" }], nextPageToken: "p2" })
      .mockRejectedValueOnce(new GmailCallDeferredError(20_000, "background"));
    await queueCleanInboxThreads({
      ...job,
      labelType: "inbox",
      deferrals: 1,
      emailProvider,
      logger,
    });

    const [first, second] = vi
      .mocked(publishToQstashAt)
      .mock.calls.map(([options]) => options.deduplicationId);
    expect(first).not.toBe(second);
  });
});

function queuedThreadIds() {
  return vi
    .mocked(bulkPublishToQstash)
    .mock.calls.flatMap(([{ items }]) =>
      items.map((item) => (item.body as { threadId: string }).threadId),
    );
}
