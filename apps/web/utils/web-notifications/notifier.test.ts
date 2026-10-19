import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  claimNotifierLeadership,
  createNewMailNotifier,
  showNewMailNotifications,
} from "@/utils/web-notifications/notifier";
import type { TrackedConversation } from "@/utils/web-notifications/new-mail";
import type { WebNotificationMode } from "@/utils/web-notifications/preference";

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

// A browser-wide lock table, shared by every simulated tab.
function createFakeLocks() {
  const queue: Array<{
    run: () => Promise<unknown>;
    signal?: AbortSignal;
    done: () => void;
  }> = [];
  let held = false;

  function drain() {
    if (held) return;
    const next = queue.shift();
    if (!next) return;
    if (next.signal?.aborted) {
      drain();
      return;
    }
    held = true;
    next.run().finally(() => {
      held = false;
      drain();
    });
  }

  return {
    request(
      _name: string,
      options: { signal?: AbortSignal },
      callback: () => Promise<unknown>,
    ) {
      return new Promise<void>((resolve) => {
        queue.push({ run: callback, signal: options.signal, done: resolve });
        drain();
      });
    },
  } as unknown as Pick<LockManager, "request">;
}

function createTab({
  locks,
  mode = "all",
  foreground = false,
  sink,
}: {
  locks: Pick<LockManager, "request">;
  mode?: WebNotificationMode;
  foreground?: boolean;
  sink: TrackedConversation[][];
}) {
  let leader = false;
  const release = claimNotifierLeadership({
    locks,
    onChange: (next) => {
      leader = next;
    },
  });
  const notifier = createNewMailNotifier({
    startedAtMs: NOW,
    getMode: () => mode,
    isLeader: () => leader,
    isForeground: () => foreground,
    notify: (conversations) => sink.push(conversations),
    loadBulkMessageIds: async () => new Set(["bulk"]),
    triageSettleMs: 10_000,
  });
  return {
    notifier,
    close() {
      notifier.dispose();
      release();
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("notifying with several tabs open", () => {
  it("notifies once for the same new mail seen by every tab", async () => {
    const locks = createFakeLocks();
    const sink: TrackedConversation[][] = [];
    const tabs = [1, 2, 3].map(() => createTab({ locks, sink }));
    await vi.advanceTimersByTimeAsync(0);

    for (const tab of tabs) tab.notifier.handle([]);
    for (const tab of tabs) tab.notifier.handle([conversation("new")]);

    expect(sink).toHaveLength(1);
    expect(sink[0].map((item) => item.id)).toEqual(["new"]);
  });

  it("hands over to another tab when the notifying tab closes", async () => {
    const locks = createFakeLocks();
    const sink: TrackedConversation[][] = [];
    const first = createTab({ locks, sink });
    const second = createTab({ locks, sink });
    await vi.advanceTimersByTimeAsync(0);

    second.notifier.handle([]);
    first.close();
    await vi.advanceTimersByTimeAsync(0);
    second.notifier.handle([conversation("after-handover")]);

    expect(sink).toHaveLength(1);
  });

  it("collapses to every tab notifying when Web Locks is unavailable", () => {
    const onChange = vi.fn();
    claimNotifierLeadership({ locks: undefined, onChange });
    expect(onChange).toHaveBeenCalledWith(true);
  });
});

describe("when to notify", () => {
  it("stays quiet while the reader is looking at Cue", async () => {
    const sink: TrackedConversation[][] = [];
    const tab = createTab({ locks: createFakeLocks(), foreground: true, sink });
    await vi.advanceTimersByTimeAsync(0);

    tab.notifier.handle([]);
    tab.notifier.handle([conversation("new")]);

    expect(sink).toEqual([]);
  });

  it("stays quiet when the reader turned notifications off", async () => {
    const sink: TrackedConversation[][] = [];
    const tab = createTab({ locks: createFakeLocks(), mode: "off", sink });
    await vi.advanceTimersByTimeAsync(0);

    tab.notifier.handle([]);
    tab.notifier.handle([conversation("new")]);
    await vi.advanceTimersByTimeAsync(20_000);

    expect(sink).toEqual([]);
  });

  it("in important mode skips mail Cue sorted as bulk, after triage settles", async () => {
    const sink: TrackedConversation[][] = [];
    const tab = createTab({
      locks: createFakeLocks(),
      mode: "important",
      sink,
    });
    await vi.advanceTimersByTimeAsync(0);

    tab.notifier.handle([]);
    tab.notifier.handle([conversation("bulk"), conversation("person")]);
    expect(sink).toEqual([]);

    await vi.advanceTimersByTimeAsync(10_000);

    expect(sink).toHaveLength(1);
    expect(sink[0].map((item) => item.id)).toEqual(["person"]);
  });

  it("in important mode still notifies when triage can't be loaded", async () => {
    const sink: TrackedConversation[][] = [];
    let leader = true;
    const notifier = createNewMailNotifier({
      startedAtMs: NOW,
      getMode: () => "important",
      isLeader: () => leader,
      isForeground: () => false,
      notify: (conversations) => sink.push(conversations),
      loadBulkMessageIds: async () => null,
      triageSettleMs: 1000,
    });

    notifier.handle([]);
    notifier.handle([conversation("person")]);
    await vi.advanceTimersByTimeAsync(1000);

    expect(sink).toHaveLength(1);
    leader = false;
  });
});

describe("showNewMailNotifications", () => {
  function fakeNotification() {
    const shown: FakeNotification[] = [];
    class FakeNotification {
      onclick: (() => void) | null = null;
      close = vi.fn();
      title: string;
      options?: NotificationOptions;
      constructor(title: string, options?: NotificationOptions) {
        this.title = title;
        this.options = options;
        shown.push(this);
      }
    }
    return { shown, FakeNotification };
  }

  it("shows the sender and subject, never the body", () => {
    const { shown, FakeNotification } = fakeNotification();
    showNewMailNotifications({
      conversations: [conversation("a")],
      Notification: FakeNotification as never,
      summaryTitle: (count) => `${count} more`,
      openThread: vi.fn(),
      focusWindow: vi.fn(),
    });

    expect(shown).toHaveLength(1);
    expect(shown[0].title).toBe("Ada Lovelace");
    expect(shown[0].options?.body).toBe("Subject a");
  });

  it("focuses the tab and opens the thread when clicked", () => {
    const { shown, FakeNotification } = fakeNotification();
    const openThread = vi.fn();
    const focusWindow = vi.fn();
    const item = conversation("a", { accountId: "acc-2", threadId: "t-9" });
    showNewMailNotifications({
      conversations: [item],
      Notification: FakeNotification as never,
      summaryTitle: (count) => `${count} more`,
      openThread,
      focusWindow,
    });

    shown[0].onclick?.();

    expect(focusWindow).toHaveBeenCalledOnce();
    expect(shown[0].close).toHaveBeenCalledOnce();
    expect(openThread).toHaveBeenCalledWith(item);
  });

  it("groups a burst into a few notifications plus one summary", () => {
    const { shown, FakeNotification } = fakeNotification();
    showNewMailNotifications({
      conversations: ["a", "b", "c", "d", "e"].map((id) => conversation(id)),
      Notification: FakeNotification as never,
      summaryTitle: (count) => `${count} more`,
      openThread: vi.fn(),
      focusWindow: vi.fn(),
    });

    expect(shown.map((entry) => entry.title)).toEqual([
      "Ada Lovelace",
      "Ada Lovelace",
      "Ada Lovelace",
      "2 more",
    ]);
  });
});
