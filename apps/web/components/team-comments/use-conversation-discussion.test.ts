/** @vitest-environment jsdom */

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useConversationDiscussion } from "./use-conversation-discussion";

const swr = vi.hoisted(() => ({
  summaryMutate: vi.fn(),
  commentsMutate: vi.fn(),
  intervals: [] as (number | undefined)[],
}));

vi.mock("swr", () => ({
  default: (_key: string, options: { refreshInterval?: number }) => {
    swr.intervals.push(options.refreshInterval);
    return { data: { generation: "g1" }, mutate: swr.summaryMutate };
  },
}));
vi.mock("swr/infinite", () => ({
  default: () => ({ data: undefined, mutate: swr.commentsMutate, size: 1 }),
}));

const visibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);

describe("useConversationDiscussion", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    swr.intervals = [];
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    setVisibility("visible");
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    if (visibilityDescriptor) {
      Object.defineProperty(document, "visibilityState", visibilityDescriptor);
    } else {
      Reflect.deleteProperty(document, "visibilityState");
    }
  });

  it("stops polling while the stream is live, and polls again once it drops", () => {
    renderHook(() => useConversationDiscussion("member-1", "conversation-1"));
    expect(swr.intervals.at(-1)).toBe(30_000);

    act(() => FakeEventSource.instances[0].emit("ready"));
    expect(swr.intervals.at(-1)).toBe(0);

    act(() => FakeEventSource.instances[0].emit("error"));
    expect(swr.intervals.at(-1)).toBe(30_000);
  });

  it("lets the stream go while hidden and catches up when shown", () => {
    renderHook(() => useConversationDiscussion("member-1", "conversation-1"));
    act(() => FakeEventSource.instances[0].emit("ready"));

    act(() => setVisibility("hidden"));
    expect(FakeEventSource.instances[0].closed).toBe(true);
    swr.summaryMutate.mockClear();

    act(() => setVisibility("visible"));
    expect(FakeEventSource.instances).toHaveLength(2);
    expect(swr.summaryMutate).toHaveBeenCalled();
  });
});

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  closed = false;
  private readonly listeners = new Map<string, Set<() => void>>();

  constructor() {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: () => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  close() {
    this.closed = true;
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
