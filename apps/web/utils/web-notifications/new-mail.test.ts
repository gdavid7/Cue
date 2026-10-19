import { describe, expect, it } from "vitest";
import {
  createNewMailTracker,
  senderDisplayName,
  type TrackedConversation,
} from "@/utils/web-notifications/new-mail";

const NOW = 1_700_000_000_000;

function conversation(
  id: string,
  overrides: Partial<TrackedConversation> = {},
): TrackedConversation {
  return {
    id,
    accountId: "acc-1",
    threadId: `thread-${id}`,
    from: "Ada Lovelace <ada@example.com>",
    subject: `Subject ${id}`,
    latestMessageAtMs: NOW + 1000,
    ...overrides,
  };
}

describe("createNewMailTracker", () => {
  it("treats mail already in the first snapshot as seen", () => {
    const tracker = createNewMailTracker({ startedAtMs: NOW });
    expect(tracker.take([conversation("a"), conversation("b")])).toEqual([]);
  });

  it("reports mail that arrives after the first snapshot exactly once", () => {
    const tracker = createNewMailTracker({ startedAtMs: NOW });
    tracker.take([conversation("a")]);

    const next = [conversation("c"), conversation("a")];
    expect(tracker.take(next).map((item) => item.id)).toEqual(["c"]);
    expect(tracker.take(next)).toEqual([]);
  });

  it("does not report old mail that only appears when a sync backfills", () => {
    const tracker = createNewMailTracker({ startedAtMs: NOW });
    tracker.take([]);

    const backfilled = conversation("old", {
      latestMessageAtMs: NOW - 24 * 60 * 60 * 1000,
    });
    expect(tracker.take([backfilled])).toEqual([]);
  });

  it("does not report a message again after it leaves and re-enters the list", () => {
    const tracker = createNewMailTracker({ startedAtMs: NOW });
    tracker.take([]);
    expect(tracker.take([conversation("a")])).toHaveLength(1);
    tracker.take([]);
    expect(tracker.take([conversation("a")])).toEqual([]);
  });
});

describe("senderDisplayName", () => {
  it("prefers the display name over the address", () => {
    expect(senderDisplayName("Ada Lovelace <ada@example.com>")).toBe(
      "Ada Lovelace",
    );
    expect(senderDisplayName('"Lovelace, Ada" <ada@example.com>')).toBe(
      "Lovelace, Ada",
    );
  });

  it("falls back to the address", () => {
    expect(senderDisplayName("ada@example.com")).toBe("ada@example.com");
    expect(senderDisplayName("<ada@example.com>")).toBe("ada@example.com");
  });
});
