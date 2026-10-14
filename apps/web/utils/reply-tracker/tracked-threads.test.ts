import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadTrackerType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import type { EmailProvider, EmailThread } from "@/utils/email/types";
import { getTrackedThreads } from "@/utils/reply-tracker/tracked-threads";

vi.mock("@/utils/prisma");

describe("getTrackedThreads", () => {
  beforeEach(() => {
    prisma.threadTracker.findMany.mockResolvedValue([]);
  });

  it("looks past archived conversations so the list doesn't empty out", async () => {
    // Archiving doesn't resolve a tracker, so the newest ones can all be archived.
    const threads = [
      thread("archived-1", []),
      thread("archived-2", []),
      thread("open-1", ["INBOX"]),
      thread("open-2", ["INBOX"]),
      thread("open-3", ["INBOX"]),
    ];
    prisma.threadTracker.findMany.mockResolvedValue(
      threads.map((t) => ({ threadId: t.id })) as never,
    );

    const result = await getTrackedThreads({
      emailAccountId: "account",
      emailProvider: provider(threads),
      type: ThreadTrackerType.NEEDS_REPLY,
      limit: 2,
      inboxOnly: true,
    });

    expect(result.map((t) => t.id)).toEqual(["open-1", "open-2"]);
    expect(prisma.threadTracker.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId: "account",
          type: ThreadTrackerType.NEEDS_REPLY,
          resolved: false,
        },
        take: 6,
      }),
    );
  });

  it("reads overfetched trackers only when the newest have left the inbox", async () => {
    const threads = Array.from({ length: 6 }, (_, index) =>
      thread(`open-${index}`, ["INBOX"]),
    );
    prisma.threadTracker.findMany.mockResolvedValue(
      threads.map((t) => ({ threadId: t.id })) as never,
    );
    const emailProvider = provider(threads);

    const result = await getTrackedThreads({
      emailAccountId: "account",
      emailProvider,
      type: ThreadTrackerType.NEEDS_REPLY,
      limit: 2,
      inboxOnly: true,
    });

    expect(result.map((t) => t.id)).toEqual(["open-0", "open-1"]);
    expect(emailProvider.getThread).toHaveBeenCalledTimes(2);
  });

  it("loads conversations a few at a time and skips ones that fail", async () => {
    const threads = Array.from({ length: 12 }, (_, index) =>
      thread(`t${index}`, ["INBOX"]),
    );
    prisma.threadTracker.findMany.mockResolvedValue(
      threads.map((t) => ({ threadId: t.id })) as never,
    );
    let active = 0;
    let maxActive = 0;
    const emailProvider = {
      getThread: vi.fn(async (threadId: string) => {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, 0));
        active--;
        if (threadId === "t0") throw new Error("gone");
        return threads.find((t) => t.id === threadId);
      }),
    } as unknown as EmailProvider;

    const result = await getTrackedThreads({
      emailAccountId: "account",
      emailProvider,
      type: ThreadTrackerType.AWAITING,
      limit: 20,
    });

    expect(result.map((t) => t.id)).toEqual(threads.slice(1).map((t) => t.id));
    expect(maxActive).toBeLessThanOrEqual(5);
  });
});

function provider(threads: EmailThread[]) {
  return {
    getThread: vi.fn(async (threadId: string) =>
      threads.find((t) => t.id === threadId),
    ),
  } as unknown as EmailProvider;
}

function thread(id: string, labelIds: string[]): EmailThread {
  return {
    id,
    snippet: "",
    messages: [{ id: `${id}-m`, threadId: id, labelIds }],
  } as unknown as EmailThread;
}
