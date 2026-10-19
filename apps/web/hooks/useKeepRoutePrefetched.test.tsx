// @vitest-environment jsdom

import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useKeepRoutePrefetched } from "./useKeepRoutePrefetched";

const prefetch = vi.hoisted(() => vi.fn());
vi.mock("next/navigation", () => ({ useRouter: () => ({ prefetch }) }));

describe("useKeepRoutePrefetched", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    prefetch.mockClear();
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("fetches the route again before a click could find it stale", () => {
    renderHook(() => useKeepRoutePrefetched("/account/home"));
    expect(prefetch).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60_000);
    expect(prefetch.mock.calls.length).toBeGreaterThanOrEqual(5);
    expect(prefetch).toHaveBeenCalledWith("/account/home", { kind: "full" });
  });

  it("asks at once when the user comes back to the tab", () => {
    renderHook(() => useKeepRoutePrefetched("/account/home"));
    window.dispatchEvent(new Event("focus"));
    expect(prefetch).toHaveBeenCalledTimes(1);
  });

  it("asks nothing while the tab is hidden, or once it is gone", () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { unmount } = renderHook(() =>
      useKeepRoutePrefetched("/account/home"),
    );
    vi.advanceTimersByTime(5 * 60_000);
    expect(prefetch).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    unmount();
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(5 * 60_000);
    expect(prefetch).not.toHaveBeenCalled();
  });

  it("asks nothing without a route, as on the route itself", () => {
    renderHook(() => useKeepRoutePrefetched(null));
    vi.advanceTimersByTime(5 * 60_000);
    window.dispatchEvent(new Event("focus"));
    expect(prefetch).not.toHaveBeenCalled();
  });
});
