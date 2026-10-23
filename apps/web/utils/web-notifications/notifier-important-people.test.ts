import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ImportantPerson } from "@inboxzero/mail-core/important-people";
import { createNewMailNotifier } from "@/utils/web-notifications/notifier";
import type { TrackedConversation } from "@/utils/web-notifications/new-mail";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";

const NOW = 1_700_000_000_000;
const TRIAGE_SETTLE_MS = 15_000;
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
  mode = "important" as WebNotificationMode,
  isQuiet = () => false,
  loadImportantPeople,
}: {
  people?: ImportantPerson[];
  bulk?: string[];
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
    await vi.advanceTimersByTimeAsync(0);
    expect(notified).toEqual([["from-dana"]]);

    await vi.advanceTimersByTimeAsync(TRIAGE_SETTLE_MS);
    expect(notified).toEqual([["from-dana"], ["other"]]);
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
