// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useIntent } from "./useIntent";

describe("useIntent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("ignores a pointer that only passes over", () => {
    const { result } = renderHook(() => useIntent(100));
    act(() => result.current.begin());
    act(() => vi.advanceTimersByTime(60));
    act(() => result.current.end());
    act(() => vi.advanceTimersByTime(500));
    expect(result.current.intended).toBe(false);
  });

  it("takes a pointer that rests as intent, and keeps it", () => {
    const { result } = renderHook(() => useIntent(100));
    act(() => result.current.begin());
    act(() => vi.advanceTimersByTime(100));
    expect(result.current.intended).toBe(true);
    act(() => result.current.end());
    expect(result.current.intended).toBe(true);
  });
});
