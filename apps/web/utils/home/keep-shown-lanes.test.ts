import { describe, expect, it } from "vitest";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { keepShownLanes, type TodayHomeData } from "./keep-shown-lanes";

describe("keepShownLanes", () => {
  it("returns a complete answer as it is", () => {
    const fresh = home("fresh");
    expect(keepShownLanes(home("shown"), fresh)).toBe(fresh);
  });

  it("keeps the rows and counts on screen for a lane still loading", () => {
    const fresh = {
      ...home("fresh"),
      waiting: [],
      pending: ["waiting"],
      stats: { ...home("fresh").stats, waiting: 0, waitingCapped: false },
    } as TodayHomeData;
    const result = keepShownLanes(home("shown"), fresh);

    expect(result.waiting).toEqual(home("shown").waiting);
    expect(result.stats.waiting).toBe(2);
    expect(result.stats.waitingCapped).toBe(true);
    // The other lanes are the fresh answer's.
    expect(result.needsYou).toEqual(home("fresh").needsYou);
    expect(result.pending).toEqual([]);
    expect(result.stale).toEqual(["waiting"]);
  });

  it("keeps rows that were themselves kept, through another slow answer", () => {
    const pendingWaiting = {
      ...home("fresh"),
      waiting: [],
      pending: ["waiting"],
    } as TodayHomeData;
    const once = keepShownLanes(home("shown"), pendingWaiting);
    const twice = keepShownLanes(once, pendingWaiting);
    expect(twice.waiting).toEqual(home("shown").waiting);
    expect(twice.stale).toEqual(["waiting"]);
  });

  it("leaves placeholders for a lane that never loaded or failed", () => {
    const fresh = {
      ...home("fresh"),
      pending: ["needsYou", "waiting"],
    } as TodayHomeData;
    const shown = {
      ...home("shown"),
      pending: ["needsYou"],
      failed: ["waiting"],
    } as TodayHomeData;
    expect(keepShownLanes(shown, fresh)).toBe(fresh);
    expect(keepShownLanes(undefined, fresh)).toBe(fresh);
  });
});

function home(subject: string): TodayHomeData {
  const row = (threadId: string) => ({
    threadId,
    fromName: "Alice",
    fromEmail: "alice@example.com",
    subject,
    preview: "Hello",
    at: "2026-10-16T10:00:00Z",
    priority: "medium",
    unread: true,
    messageId: `${threadId}-message`,
    starred: false,
    inInbox: true,
  });
  return {
    needsYou: [row("needs")],
    waiting: [row("waiting-1"), row("waiting-2")],
    alsoInInbox: [row("inbox")],
    reading: [],
    pending: [],
    failed: [],
    stats: {
      needsYou: 1,
      estimatedMinutes: 3,
      agentWorking: 0,
      waiting: 2,
      needsYouCapped: false,
      waitingCapped: true,
      readingCapped: false,
    },
  } as unknown as GetHomeResponse;
}
