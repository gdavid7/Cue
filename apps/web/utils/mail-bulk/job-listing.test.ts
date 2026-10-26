import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { mailBulkJobListings } from "@/utils/mail-bulk/job-listing";

vi.mock("@/utils/prisma");

const JOB_ID = "00000000-0000-4000-8000-000000000001";

describe("mailBulkJobListings", () => {
  it("reads a job's listing only for the account that owns it", async () => {
    prisma.mailBulkJobListing.findFirst.mockResolvedValue(null);

    await expect(
      mailBulkJobListings.get(JOB_ID, "other-account"),
    ).resolves.toBeNull();

    expect(prisma.mailBulkJobListing.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { jobId: JOB_ID, emailAccountId: "other-account" },
      }),
    );
  });

  it("returns the view and the page it is on", async () => {
    prisma.mailBulkJobListing.findFirst.mockResolvedValue({
      scope: { q: "from:alice@example.com" },
      pageToken: null,
    } as never);

    await expect(mailBulkJobListings.get(JOB_ID, "account-1")).resolves.toEqual(
      { scope: { q: "from:alice@example.com" } },
    );
  });

  it("moves and removes the cursor only within the owning account", async () => {
    await mailBulkJobListings.setPageToken(JOB_ID, "account-1", "next");
    await mailBulkJobListings.remove(JOB_ID, "account-1");

    expect(prisma.mailBulkJobListing.updateMany).toHaveBeenCalledWith({
      where: { jobId: JOB_ID, emailAccountId: "account-1" },
      data: { pageToken: "next" },
    });
    expect(prisma.mailBulkJobListing.deleteMany).toHaveBeenCalledWith({
      where: { jobId: JOB_ID, emailAccountId: "account-1" },
    });
  });

  it("clears the account's own abandoned listings when a job starts", async () => {
    await mailBulkJobListings.create({
      jobId: JOB_ID,
      emailAccountId: "account-1",
      scope: { type: "inbox" },
    });

    expect(prisma.mailBulkJobListing.deleteMany).toHaveBeenCalledWith({
      where: {
        emailAccountId: "account-1",
        updatedAt: { lt: expect.any(Date) },
      },
    });
    expect(prisma.mailBulkJobListing.create).toHaveBeenCalledWith({
      data: {
        jobId: JOB_ID,
        emailAccountId: "account-1",
        scope: { type: "inbox" },
      },
    });
  });

  it("sweeps every account's listings untouched for a day", async () => {
    prisma.mailBulkJobListing.deleteMany.mockResolvedValue({ count: 2 });
    // A real clock can tick between reading "now" here and in the sweep.
    vi.useFakeTimers({
      now: new Date("2026-10-26T12:00:00Z"),
      toFake: ["Date"],
    });

    try {
      await expect(mailBulkJobListings.deleteAbandoned()).resolves.toBe(2);
    } finally {
      vi.useRealTimers();
    }

    const [args] = prisma.mailBulkJobListing.deleteMany.mock.calls[0];
    expect(Object.keys(args?.where ?? {})).toEqual(["updatedAt"]);
    expect((args?.where?.updatedAt as { lt: Date }).lt).toEqual(
      new Date("2026-10-25T12:00:00Z"),
    );
  });
});
