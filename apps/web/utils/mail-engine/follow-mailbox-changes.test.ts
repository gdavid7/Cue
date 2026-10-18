/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  followMailboxChanges,
  getFollowedAccountIds,
} from "./follow-mailbox-changes";

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

  it("closes the connection when stopped", () => {
    const { stop } = follow();

    stop();
    setVisibility("hidden");
    setVisibility("visible");

    expect(sources).toHaveLength(1);
    expect(sources[0].closed).toBe(true);
  });
});

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
  it("follows every account in All inboxes, the open one first", () => {
    expect(getFollowedAccountIds("b", ["a", "b", "c"])).toEqual([
      "b",
      "a",
      "c",
    ]);
  });

  it("follows only the open account when All inboxes has one", () => {
    expect(getFollowedAccountIds("a", ["a"])).toEqual(["a"]);
    // An account left out of All inboxes still gets its own when open.
    expect(getFollowedAccountIds("x", ["a"])).toEqual(["x"]);
  });

  it("keeps the number of streams bounded", () => {
    expect(
      getFollowedAccountIds("a", ["a", "b", "c", "d", "e", "f"]),
    ).toHaveLength(4);
  });
});
