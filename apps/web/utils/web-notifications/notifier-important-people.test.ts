import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportantPerson } from "@inboxzero/mail-core/important-people";
import {
  createNewMailNotifier,
  showNewMailNotifications,
} from "@/utils/web-notifications/notifier";
import type { TrackedConversation } from "@/utils/web-notifications/new-mail";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";

const NOW = 1_700_000_000_000;
const TRIAGE_SETTLE_MS = 15_000;
const IMPORTANT_BATCH_MS = 750;
const DANA: ImportantPerson = {
  accountId: "acc-1",
  email: "dana@example.com",
  addedAtMs: 1,
};

function conversation(
  id: string,
  overrides: Partial<TrackedConversation> = {},
): TrackedConversation {
  return {
    id,
    accountId: "acc-1",
    threadId: `thread-${id}`,
    from: "Ada <ada@example.com>",
    subject: id,
    latestMessageAtMs: NOW + 1000,
    ...overrides,
  };
}

function setup({
  people = [DANA],
  bulk = [] as string[],
  muted = [] as string[],
  mode = "important" as WebNotificationMode,
  isQuiet = () => false,
  loadImportantPeople,
}: {
  people?: ImportantPerson[];
  bulk?: string[];
  muted?: string[];
  mode?: WebNotificationMode;
  isQuiet?: () => boolean;
  loadImportantPeople?: () => Promise<ImportantPerson[] | null>;
} = {}) {
  const notified: string[][] = [];
  const notifier = createNewMailNotifier({
    startedAtMs: NOW,
    getMode: () => mode,
    isQuiet,
    isLeader: () => true,
    isForeground: () => false,
    notify: (conversations) => notified.push(conversations.map((c) => c.id)),
    loadBulkMessageIds: async () => new Set(bulk),
    loadImportantPeople: loadImportantPeople ?? (async () => people),
    loadMutedThreadIds: async () => new Set(muted),
    triageSettleMs: TRIAGE_SETTLE_MS,
  });
  notifier.handle([]);
  return { notifier, notified };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("mail from an important person", () => {
  it("notifies even when triage sorted it as bulk", async () => {
    const { notifier, notified } = setup({ bulk: ["from-dana", "promo"] });

    notifier.handle([
      conversation("from-dana", { from: '"Dana" <Dana@Example.com>' }),
      conversation("promo"),
    ]);
    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);

    expect(notified).toEqual([["from-dana"]]);
  });

  it("notifies without waiting for triage, and only once", async () => {
    const { notifier, notified } = setup();

    notifier.handle([
      conversation("from-dana", { from: "dana@example.com" }),
      conversation("other"),
    ]);
    await vi.advanceTimersByTimeAsync(IMPORTANT_BATCH_MS);
    expect(notified).toEqual([["from-dana"]]);

    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);
    expect(notified).toEqual([["from-dana"], ["other"]]);
  });

  it("stays silent for a conversation the reader muted", async () => {
    const { notifier, notified } = setup({ muted: ["thread-muted-dana"] });

    notifier.handle([
      conversation("muted-dana", { from: "dana@example.com" }),
      conversation("dana", { from: "dana@example.com" }),
    ]);
    await vi.advanceTimersByTimeAsync(IMPORTANT_BATCH_MS + TRIAGE_SETTLE_MS);

    expect(notified).toEqual([["dana"]]);
  });

  it("lands a burst as one batch, still capped at three notifications and a summary", async () => {
    const { notifier, notified } = setup();
    const burst = Array.from({ length: 10 }, (_, index) =>
      conversation(`dana-${index}`, { from: "Dana <dana@example.com>" }),
    );

    // Arriving over a few snapshots, as sync delivers them.
    for (let index = 0; index < burst.length; index++) {
      notifier.handle(burst.slice(0, index + 1));
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(IMPORTANT_BATCH_MS);

    expect(notified).toHaveLength(1);
    expect(notified[0]).toHaveLength(10);

    const shown: string[] = [];
    showNewMailNotifications({
      conversations: burst,
      Notification: class {
        onclick: (() => void) | null = null;
        constructor(title: string) {
          shown.push(title);
        }
        close() {}
      } as never,
      summaryTitle: (count) => `${count} more new messages`,
      openThread: () => undefined,
      focusWindow: () => undefined,
    });
    expect(shown).toEqual(["Dana", "Dana", "Dana", "7 more new messages"]);

    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);
    expect(notified).toHaveLength(1);
  });

  it("doesn't match a display name dressed up as their address", async () => {
    const { notifier, notified } = setup({ bulk: ["spoof"] });

    notifier.handle([
      conversation("spoof", { from: '"dana@example.com" <x@evil.com>' }),
    ]);
    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);

    expect(notified).toEqual([]);
  });

  it("counts only in the account they were starred in", async () => {
    const { notifier, notified } = setup({ bulk: ["elsewhere"] });

    notifier.handle([
      conversation("elsewhere", {
        accountId: "acc-2",
        from: "dana@example.com",
      }),
    ]);
    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);

    expect(notified).toEqual([]);
  });

  it("falls back to triage when stars can't be read", async () => {
    const { notifier, notified } = setup({
      bulk: ["from-dana"],
      loadImportantPeople: async () => {
        throw new Error("engine gone");
      },
    });

    notifier.handle([
      conversation("from-dana", { from: "dana@example.com" }),
      conversation("other"),
    ]);
    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);

    expect(notified).toEqual([["other"]]);
  });

  it("stays quiet while notifications are paused", async () => {
    const { notifier, notified } = setup({ isQuiet: () => true });

    notifier.handle([conversation("from-dana", { from: "dana@example.com" })]);
    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);

    expect(notified).toEqual([]);
  });
});
