// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLoopSteps } from "@/app/(landing)/login/useLoopPlayback";

const DURATIONS = [1000, 2000, 500];

describe("useLoopSteps", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("steps through each duration and wraps around", () => {
    const { result } = renderHook(() => useLoopSteps(DURATIONS, true, 0));

    act(() => vi.advanceTimersByTime(999));
    expect(result.current).toBe(0);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(2000));
    expect(result.current).toBe(2);
    act(() => vi.advanceTimersByTime(500));
    expect(result.current).toBe(0);
  });

  it("resumes a paused step with the time it had left", () => {
    const { result, rerender } = renderHook(
      ({ playing }) => useLoopSteps(DURATIONS, playing, 1),
      { initialProps: { playing: true } },
    );

    act(() => vi.advanceTimersByTime(1500));
    rerender({ playing: false });
    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current).toBe(1);

    rerender({ playing: true });
    act(() => vi.advanceTimersByTime(499));
    expect(result.current).toBe(1);
    act(() => vi.advanceTimersByTime(1));
    expect(result.current).toBe(2);
  });
});
