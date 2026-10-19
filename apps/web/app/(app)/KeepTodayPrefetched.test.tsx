// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KeepTodayPrefetched } from "./KeepTodayPrefetched";

const state = vi.hoisted(() => ({
  prefetch: vi.fn(),
  pathname: "/mail/u/0/inbox",
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ prefetch: state.prefetch }),
  usePathname: () => state.pathname,
}));
vi.mock("@/hooks/useTodayHref", () => ({
  useTodayHref: () => "/account-1/home",
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));

describe("KeepTodayPrefetched", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubEnv("NODE_ENV", "production");
    state.prefetch.mockClear();
    state.pathname = "/mail/u/0/inbox";
  });
  afterEach(() => {
    cleanup();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("asks nothing while the user is away, however long", () => {
    render(<KeepTodayPrefetched />);
    vi.advanceTimersByTime(60 * 60_000);
    expect(state.prefetch).not.toHaveBeenCalled();
  });

  it("asks for the whole route when the user comes back to the tab", () => {
    render(<KeepTodayPrefetched />);
    window.dispatchEvent(new Event("focus"));
    expect(state.prefetch).toHaveBeenCalledTimes(1);
    expect(state.prefetch).toHaveBeenCalledWith("/account-1/home", {
      kind: "full",
    });
  });

  it("asks at most once each half minute while the user is active", () => {
    render(<KeepTodayPrefetched />);
    // Five minutes of steady activity, every second.
    for (let second = 1; second <= 300; second++) {
      vi.advanceTimersByTime(1000);
      window.dispatchEvent(new Event("pointermove"));
    }
    expect(state.prefetch).toHaveBeenCalledTimes(10);
  });

  it("asks nothing for a hidden tab, or once it is gone", () => {
    const visibility = vi
      .spyOn(document, "visibilityState", "get")
      .mockReturnValue("hidden");
    const { unmount } = render(<KeepTodayPrefetched />);
    document.dispatchEvent(new Event("visibilitychange"));
    expect(state.prefetch).not.toHaveBeenCalled();

    visibility.mockReturnValue("visible");
    unmount();
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("keydown"));
    expect(state.prefetch).not.toHaveBeenCalled();
  });

  it("asks nothing on Today itself", () => {
    state.pathname = "/account-1/home";
    render(<KeepTodayPrefetched />);
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
    window.dispatchEvent(new Event("keydown"));
    expect(state.prefetch).not.toHaveBeenCalled();
  });
});
