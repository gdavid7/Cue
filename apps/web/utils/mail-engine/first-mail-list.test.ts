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
    afterFirstMailList(callback, { fallbackMs: 60_000 });

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

  it("never runs once cancelled", async () => {
    const callback = vi.fn();
    const cancel = afterFirstMailList(callback);
    markFirstMailListShown();
    cancel();

    await vi.advanceTimersByTimeAsync(20_000);

    expect(callback).not.toHaveBeenCalled();
  });
});
