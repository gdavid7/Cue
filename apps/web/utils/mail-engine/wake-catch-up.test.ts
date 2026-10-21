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
    stops.push(followWakeCatchUp({ isStale, onWake }));
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
    stops.push(followWakeCatchUp({ isStale: () => true, onWake }));

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

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
}
