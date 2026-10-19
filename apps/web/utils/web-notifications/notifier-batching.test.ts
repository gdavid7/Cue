import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createNewMailNotifier } from "@/utils/web-notifications/notifier";
import type { TrackedConversation } from "@/utils/web-notifications/new-mail";

const NOW = 1_700_000_000_000;

function conversation(id: string, accountId = "acc-1"): TrackedConversation {
  return {
    id,
    accountId,
    threadId: `thread-${id}`,
    from: "Ada <ada@example.com>",
    subject: id,
    latestMessageAtMs: NOW + 1000,
  };
}

function setup() {
  const notified: TrackedConversation[][] = [];
  const loadBulkMessageIds = vi.fn(async () => new Set<string>());
  const notifier = createNewMailNotifier({
    startedAtMs: NOW,
    getMode: () => "important",
    isLeader: () => true,
    isForeground: () => false,
    notify: (conversations) => notified.push(conversations),
    loadBulkMessageIds,
    triageSettleMs: 15_000,
  });
  return { notifier, notified, loadBulkMessageIds };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("triage lookups in important mode", () => {
  it("batches mail arriving while triage settles into one lookup per account", async () => {
    const { notifier, notified, loadBulkMessageIds } = setup();
    notifier.handle([]);

    notifier.handle([conversation("a")]);
    await vi.advanceTimersByTimeAsync(5000);
    notifier.handle([conversation("b"), conversation("a")]);
    await vi.advanceTimersByTimeAsync(5000);
    notifier.handle([conversation("c", "acc-2"), conversation("b")]);
    await vi.advanceTimersByTimeAsync(10_000);

    expect(loadBulkMessageIds).toHaveBeenCalledTimes(2);
    expect(notified).toHaveLength(1);
    expect(notified[0].map((item) => item.id).sort()).toEqual(["a", "b", "c"]);
  });
});

describe("before the first sync completes", () => {
  it("records nothing, so the mail that sync brings in isn't announced", () => {
    const { notifier, notified } = setup();

    notifier.handle([conversation("cached")], false);
    notifier.handle([conversation("cached"), conversation("backfill")], true);
    vi.advanceTimersByTime(20_000);

    expect(notified).toEqual([]);
  });

  it("announces mail that arrives after the seeding snapshot", async () => {
    const { notifier, notified } = setup();

    notifier.handle([conversation("cached")], true);
    notifier.handle([conversation("fresh"), conversation("cached")], true);
    await vi.advanceTimersByTimeAsync(15_000);

    expect(notified.flat().map((item) => item.id)).toEqual(["fresh"]);
  });
});
