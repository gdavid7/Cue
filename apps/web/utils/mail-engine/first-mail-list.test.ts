/** @vitest-environment jsdom */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  afterFirstMailList,
  markFirstMailListShown,
  resetFirstMailListForTesting,
} from "./first-mail-list";

beforeEach(() => {
  vi.useFakeTimers();
  // jsdom has no idle callbacks; an idle page runs them on the next tick.
  vi.stubGlobal("requestIdleCallback", (run: () => void) => setTimeout(run, 0));
  vi.stubGlobal("cancelIdleCallback", (id: number) => clearTimeout(id));
});

afterEach(() => {
  resetFirstMailListForTesting();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("afterFirstMailList", () => {
  it("waits for the mail list, then for the engine's catch-up, before running", async () => {
    const callback = vi.fn();
    afterFirstMailList(callback, { fallbackMs: 60_000, capMs: 60_000 });

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).not.toHaveBeenCalled();

    markFirstMailListShown();
    await vi.advanceTimersByTimeAsync(1000);
    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("runs once on a page that never shows a mail list", async () => {
    const callback = vi.fn();
    afterFirstMailList(callback, { fallbackMs: 5000 });

    await vi.advanceTimersByTimeAsync(10_000);
    markFirstMailListShown();
    await vi.advanceTimersByTimeAsync(10_000);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("runs by the cap even while the page has not finished loading", async () => {
    // A slow resource can hold the load event, which the idle wait follows.
    Object.defineProperty(document, "readyState", {
      configurable: true,
      get: () => "loading",
    });
    try {
      const callback = vi.fn();
      afterFirstMailList(callback, { capMs: 10_000 });
      markFirstMailListShown();

      await vi.advanceTimersByTimeAsync(9000);
      expect(callback).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(callback).toHaveBeenCalledTimes(1);

      // The page's load arriving later does not run it again.
      window.dispatchEvent(new Event("load"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(callback).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(document, "readyState");
    }
  });

  it("runs right after the list for work that must not wait", async () => {
    const callback = vi.fn();
    afterFirstMailList(callback, { settleMs: 0, fallbackMs: 2000 });

    markFirstMailListShown();
    await vi.advanceTimersByTimeAsync(10);

    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("never runs once cancelled", async () => {
    const callback = vi.fn();
    const cancel = afterFirstMailList(callback);
    markFirstMailListShown();
    cancel();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(callback).not.toHaveBeenCalled();
  });
});
