/**
 * @vitest-environment jsdom
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { followWakeCatchUp } from "./wake-catch-up";

const visibilityDescriptor = Object.getOwnPropertyDescriptor(
  document,
  "visibilityState",
);
const MINUTE = 60_000;

describe("followWakeCatchUp", () => {
  let stops: (() => void)[];

  beforeEach(() => {
    vi.useFakeTimers();
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

  function follow({ stale = true }: { stale?: boolean } = {}) {
    const isStale = vi.fn(() => stale);
    const onWake = vi.fn(async () => undefined);
    stops.push(
      followWakeCatchUp({
        accountId: "acc-1",
        isStale,
        onWake,
        locks: undefined,
      }),
    );
    return { isStale, onWake };
  }

  it("catches up once, shortly after a tab hidden over 15 minutes is shown", async () => {
    const { onWake } = follow();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(16 * MINUTE);
    setVisibility("visible");
    expect(onWake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onWake).toHaveBeenCalledTimes(1);

    // Focus and further shows without another long absence ask for nothing.
    window.dispatchEvent(new Event("focus"));
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does nothing after a short absence", async () => {
    const { onWake } = follow();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(14 * MINUTE);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(onWake).not.toHaveBeenCalled();
  });

  it("leaves it to the engine when the mailbox kept syncing or caught up on show", async () => {
    const { isStale, onWake } = follow({ stale: false });

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(30 * MINUTE);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2000);

    // Asked when the wait ends, not when the tab shows, so a reconnect
    // catch-up that finished meanwhile counts.
    expect(isStale).toHaveBeenCalledTimes(1);
    expect(onWake).not.toHaveBeenCalled();
  });

  it("counts flicking away and back during the wait as the same wake", async () => {
    const { onWake } = follow();

    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(500);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(500);
    setVisibility("visible");
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2000);

    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("starts no second catch-up while one is still running", async () => {
    let finish: () => void = () => undefined;
    const onWake = vi.fn(
      () => new Promise<void>((resolve) => (finish = resolve)),
    );
    stops.push(
      followWakeCatchUp({
        accountId: "acc-1",
        isStale: () => true,
        onWake,
        locks: undefined,
      }),
    );

    for (let wake = 0; wake < 2; wake++) {
      setVisibility("hidden");
      await vi.advanceTimersByTimeAsync(20 * MINUTE);
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(2000);
    }
    expect(onWake).toHaveBeenCalledTimes(1);

    finish();
    await vi.advanceTimersByTimeAsync(0);
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onWake).toHaveBeenCalledTimes(2);
  });

  it("aborts a catch-up in flight when stopped", async () => {
    let signal: AbortSignal | undefined;
    const stop = followWakeCatchUp({
      accountId: "acc-1",
      isStale: () => true,
      onWake: (wakeSignal) => {
        signal = wakeSignal;
        return new Promise(() => undefined);
      },
      locks: undefined,
    });
    await wake();
    expect(signal?.aborted).toBe(false);

    stop();

    expect(signal?.aborted).toBe(true);
  });

  it("leaves the read to another tab of this browser already doing it", async () => {
    const onWake = vi.fn(async () => undefined);
    const held = new Set<string>();
    const locks = {
      request: vi.fn(
        async (
          name: string,
          options: LockOptions,
          callback: (lock: Lock | null) => unknown,
        ) => {
          // As browsers do.
          if (options.ifAvailable && options.signal)
            throw new DOMException(
              "ifAvailable with signal",
              "NotSupportedError",
            );
          if (held.has(name)) return callback(null);
          held.add(name);
          try {
            return await callback({ name, mode: "exclusive" });
          } finally {
            held.delete(name);
          }
        },
      ),
    } as unknown as Pick<LockManager, "request">;
    stops.push(
      followWakeCatchUp({
        accountId: "acc-1",
        isStale: () => true,
        onWake,
        locks,
      }),
    );
    held.add("cue:wake-catch-up:acc-1");
    await wake();
    expect(onWake).not.toHaveBeenCalled();

    held.clear();
    await wake();
    expect(onWake).toHaveBeenCalledTimes(1);
    expect(locks.request).toHaveBeenCalledWith(
      "cue:wake-catch-up:acc-1",
      expect.objectContaining({ ifAvailable: true }),
      expect.any(Function),
    );
  });

  it("treats a page restored from the back/forward cache as a wake", async () => {
    const { onWake } = follow();

    window.dispatchEvent(new Event("pagehide"));
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    await vi.advanceTimersByTimeAsync(2000);

    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("catches up once after a laptop slept with the tab showing", async () => {
    const { onWake } = follow();

    // No timer ran while it slept; only the clock moved.
    vi.setSystemTime(Date.now() + 20 * MINUTE);
    expect(onWake).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30_000 + 2000);
    expect(onWake).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(10 * MINUTE);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not count a short sleep with the tab showing", async () => {
    const { onWake } = follow();

    vi.setSystemTime(Date.now() + 14 * MINUTE);
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(onWake).not.toHaveBeenCalled();
  });

  it("asks nothing of a tab that stayed open and awake", async () => {
    const { isStale, onWake } = follow();

    await vi.advanceTimersByTimeAsync(60 * MINUTE);

    expect(isStale).not.toHaveBeenCalled();
    expect(onWake).not.toHaveBeenCalled();
  });

  it.each([
    ["resume", () => document.dispatchEvent(new Event("resume"))],
    ["online", () => window.dispatchEvent(new Event("online"))],
  ])("treats %s after a long gap as a wake", async (_name, fire) => {
    const { onWake } = follow();

    vi.setSystemTime(Date.now() + 20 * MINUTE);
    fire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onWake).toHaveBeenCalledTimes(1);

    // Again soon after is not another gap.
    fire();
    await vi.advanceTimersByTimeAsync(2000);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("does not take coming back online after a short gap as a wake", async () => {
    const { onWake } = follow();

    vi.setSystemTime(Date.now() + 5 * MINUTE);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);

    expect(onWake).not.toHaveBeenCalled();
  });

  it("leaves a hidden tab's absence to it being shown again", async () => {
    const { onWake } = follow();

    setVisibility("hidden");
    vi.setSystemTime(Date.now() + 20 * MINUTE);
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(5 * MINUTE);
    expect(onWake).not.toHaveBeenCalled();

    setVisibility("visible");
    await vi.advanceTimersByTimeAsync(2000);
    expect(onWake).toHaveBeenCalledTimes(1);
  });

  it("stops listening when stopped", async () => {
    const { onWake } = follow();
    setVisibility("hidden");
    await vi.advanceTimersByTimeAsync(20 * MINUTE);
    setVisibility("visible");
    for (const stop of stops) stop();
    stops = [];
    await vi.advanceTimersByTimeAsync(2000);

    expect(onWake).not.toHaveBeenCalled();
  });
});

async function wake() {
  setVisibility("hidden");
  await vi.advanceTimersByTimeAsync(20 * MINUTE);
  setVisibility("visible");
  await vi.advanceTimersByTimeAsync(2000);
}

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
