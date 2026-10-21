/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  followMailboxChanges,
  getFollowedAccountIds,
} from "./follow-mailbox-changes";
import { resetSigningOut, startSigningOut } from "@/utils/signing-out";

const visibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

describe("followMailboxChanges", () => {
  let sources: FakeEventSource[];
  let stops: (() => void)[];

  beforeEach(() => {
    sources = [];
    stops = [];
    setVisibility("visible");
  });

  afterEach(() => {
    for (const stop of stops) stop();
    vi.useRealTimers();
    if (visibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  function follow(onChange = vi.fn()) {
    const stop = followMailboxChanges({
      accountId: "acc/1",
      onChange,
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        return source as unknown as EventSource;
      },
    });
    stops.push(stop);
    return { onChange, stop };
  }

  it("closes the stream when sign-out starts and does not reopen it", () => {
    follow();
    expect(sources).toHaveLength(1);

    startSigningOut();
    window.dispatchEvent(new Event("focus"));

    expect(sources[0].closed).toBe(true);
    expect(sources).toHaveLength(1);
    resetSigningOut();
  });

  it("syncs when the server signals a mailbox change", () => {
    const { onChange } = follow();

    expect(sources).toHaveLength(1);
    expect(sources[0].url).toBe("/api/mail-stream?emailAccountId=acc%2F1");
    sources[0].emit("mailbox-change");
    sources[0].emit("heartbeat");

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("tells Today about tracker changes without syncing the mailbox", () => {
    const onTrackersChange = vi.fn();
    const onChange = vi.fn();
    stops.push(
      followMailboxChanges({
        accountId: "acc/1",
        onChange,
        onTrackersChange,
        createEventSource: (url) => {
          const source = new FakeEventSource(url);
          sources.push(source);
          return source as unknown as EventSource;
        },
      }),
    );

    sources[0].emit("trackers-change");

    expect(onTrackersChange).toHaveBeenCalledTimes(1);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("catches up each time the stream (re)connects", () => {
    const { onChange } = follow();

    sources[0].emit("ready");
    sources[0].emit("ready");

    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("holds no connection while hidden and reconnects when shown again", () => {
    follow();

    setVisibility("hidden");
    expect(sources[0].closed).toBe(true);

    setVisibility("visible");
    expect(sources).toHaveLength(2);
    expect(sources[1].closed).toBe(false);
  });

  it("reopens a stream the browser gave up on", () => {
    vi.useFakeTimers();
    follow();

    sources[0].readyState = 0;
    sources[0].emit("error");
    vi.advanceTimersByTime(60_000);
    expect(sources).toHaveLength(1);

    sources[0].readyState = 2;
    sources[0].emit("error");
    vi.advanceTimersByTime(30_000);
    expect(sources).toHaveLength(2);
  });

  it("catches up as soon as a hidden tab is shown, without waiting on the stream", () => {
    const { onChange } = follow();
    sources[0].emit("ready");
    onChange.mockClear();

    setVisibility("hidden");
    setVisibility("visible");
    expect(onChange).toHaveBeenCalledTimes(1);

    // The focus that comes with showing the tab adds no catch-up of its own.
    window.dispatchEvent(new Event("focus"));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("catches up once when the window regains focus repeatedly", () => {
    const { onChange } = follow();
    sources[0].emit("ready");
    onChange.mockClear();

    window.dispatchEvent(new Event("focus"));
    window.dispatchEvent(new Event("focus"));

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("keeps catching up while visible without a working stream", () => {
    vi.useFakeTimers();
    const { onChange } = follow();
    sources[0].readyState = 2;
    sources[0].emit("error");

    vi.advanceTimersByTime(29_000);
    expect(onChange).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1000);
    sources[1].emit("ready");
    onChange.mockClear();
    vi.advanceTimersByTime(60_000);
    expect(onChange).not.toHaveBeenCalled();
  });

  it("does not connect while starting hidden", () => {
    setVisibility("hidden");
    follow();

    expect(sources).toHaveLength(0);
  });

  it("lets the stream go once nobody has used a visible tab for a while, and reconnects on the next input", () => {
    vi.useFakeTimers();
    const { onChange } = follow();
    sources[0].emit("ready");
    onChange.mockClear();

    vi.advanceTimersByTime(4 * 60_000);
    window.dispatchEvent(new Event("pointermove"));
    vi.advanceTimersByTime(4 * 60_000);
    expect(sources[0].closed).toBe(false);

    vi.advanceTimersByTime(60_000 + 15_000);
    expect(sources[0].closed).toBe(true);
    // An idle tab neither streams nor polls; the version poll covers it.
    vi.advanceTimersByTime(10 * 60_000);
    expect(sources).toHaveLength(1);
    expect(onChange).not.toHaveBeenCalled();

    window.dispatchEvent(new Event("keydown"));
    expect(sources).toHaveLength(2);
    expect(sources[1].closed).toBe(false);
    // Catches up at once, without waiting for the new stream to connect.
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("streams each account from one tab per browser, handing over when that tab is hidden", async () => {
    const locks = new FakeLocks();
    const first = followTab(locks);
    const second = followTab(locks);
    await flush();

    expect(sources).toHaveLength(1);
    expect(first.sources).toHaveLength(1);
    expect(second.sources).toHaveLength(0);

    // Hiding the document hides both fake tabs; the leader steps down and the
    // other, still waiting, gives up its claim too.
    setVisibility("hidden");
    await flush();
    expect(first.sources[0].closed).toBe(true);
    expect(locks.held()).toEqual([]);

    setVisibility("visible");
    await flush();
    expect(sources.filter((source) => !source.closed)).toHaveLength(1);

    // When the leading tab closes, the waiting one takes over.
    const leader = first.sources.some((source) => !source.closed)
      ? first
      : second;
    const follower = leader === first ? second : first;
    leader.stop();
    await flush();
    expect(follower.sources.filter((source) => !source.closed)).toHaveLength(1);
    expect(locks.held()).toEqual(["cue:mail-stream:acc/1"]);
  });

  it("does not poll from a tab that leaves the stream to another", async () => {
    vi.useFakeTimers();
    const locks = new FakeLocks();
    const first = followTab(locks);
    const second = followTab(locks);
    await flush();
    first.sources[0].readyState = 2;
    first.sources[0].emit("error");

    vi.advanceTimersByTime(15_000);

    expect(first.onChange).toHaveBeenCalledTimes(1);
    expect(second.onChange).not.toHaveBeenCalled();
  });

  it("lets the stream and its lock go while the page sits in the back/forward cache", async () => {
    const locks = new FakeLocks();
    const tab = followTab(locks);
    await flush();
    expect(locks.held()).toEqual(["cue:mail-stream:acc/1"]);

    window.dispatchEvent(new Event("pagehide"));
    await flush();
    expect(tab.sources[0].closed).toBe(true);
    expect(locks.held()).toEqual([]);
    // Input on a cached page does not take the stream back.
    window.dispatchEvent(new Event("keydown"));
    await flush();
    expect(locks.held()).toEqual([]);

    window.dispatchEvent(pageShow(true));
    await flush();
    expect(locks.held()).toEqual(["cue:mail-stream:acc/1"]);
    expect(tab.sources.filter((source) => !source.closed)).toHaveLength(1);
  });

  function followTab(locks: FakeLocks) {
    const tab = { sources: [] as FakeEventSource[], onChange: vi.fn() };
    const stop = followMailboxChanges({
      accountId: "acc/1",
      onChange: tab.onChange,
      locks: locks as unknown as LockManager,
      createEventSource: (url) => {
        const source = new FakeEventSource(url);
        sources.push(source);
        tab.sources.push(source);
        return source as unknown as EventSource;
      },
    });
    stops.push(stop);
    return { ...tab, stop };
  }

  it("closes the connection when stopped", () => {
    const { stop } = follow();

    stop();
    setVisibility("hidden");
    setVisibility("visible");

    expect(sources).toHaveLength(1);
    expect(sources[0].closed).toBe(true);
  });
});

// The Web Locks behaviour the stream relies on: one holder per name, a FIFO
// queue, and an aborted request leaving the queue.
class FakeLocks {
  private readonly holders = new Map<string, symbol>();
  private readonly queues = new Map<string, (() => void)[]>();

  held() {
    return [...this.holders.keys()];
  }

  query() {
    return Promise.resolve({
      held: this.held().map((name) => ({ name })),
      pending: [],
    });
  }

  request(
    name: string,
    options: { signal?: AbortSignal },
    callback: () => Promise<void> | undefined,
  ) {
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        const token = Symbol(name);
        this.holders.set(name, token);
        Promise.resolve(callback()).finally(() => {
          this.holders.delete(name);
          this.queues.get(name)?.shift()?.();
          resolve();
        });
      };
      if (!this.holders.has(name)) {
        grant();
        return;
      }
      const queue = this.queues.get(name) ?? [];
      queue.push(grant);
      this.queues.set(name, queue);
      options.signal?.addEventListener("abort", () => {
        const index = queue.indexOf(grant);
        if (index < 0) return;
        queue.splice(index, 1);
        reject(new DOMException("Aborted", "AbortError"));
      });
    });
  }
}

function pageShow(persisted: boolean) {
  const event = new Event("pageshow") as PageTransitionEvent;
  Object.defineProperty(event, "persisted", { value: persisted });
  return event;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

class FakeEventSource {
  closed = false;
  readyState = 1;
  private readonly listeners = new Map<string, Set<() => void>>();

  readonly url: string;

  constructor(url: string) {
    this.url = url;
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
    this.readyState = 2;
  }

  emit(type: string) {
    for (const listener of this.listeners.get(type) ?? []) listener();
  }
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}

describe("getFollowedAccountIds", () => {
  it("across accounts, follows every account in All inboxes, the open one first", () => {
    expect(getFollowedAccountIds("b", ["a", "b", "c"], true)).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("on one account's pages, follows only that account", () => {
    expect(getFollowedAccountIds("b", ["a", "b", "c"], false)).toEqual(["b"]);
  });

  it("follows only the open account when All inboxes has one", () => {
    expect(getFollowedAccountIds("a", ["a"], true)).toEqual(["a"]);
    // An account left out of All inboxes still gets its own when open.
    expect(getFollowedAccountIds("x", ["a"], true)).toEqual(["x"]);
  });

  it("keeps the number of streams bounded", () => {
    expect(
      getFollowedAccountIds("a", ["a", "b", "c", "d", "e", "f"], true),
    ).toHaveLength(4);
  });
});
