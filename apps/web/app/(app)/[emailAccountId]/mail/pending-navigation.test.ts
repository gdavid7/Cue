// @vitest-environment jsdom

import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isSidebarRowActive, usePendingNavigation } from "./pending-navigation";

const pending = { href: "/account-1/home", from: "/mail/u/0/inbox" };

describe("isSidebarRowActive", () => {
  it("follows the open view when nothing is pending", () => {
    expect(
      isSidebarRowActive({
        active: true,
        href: "/mail/u/0/inbox",
        pending: null,
        pathname: "/mail/u/0/inbox",
      }),
    ).toBe(true);
  });

  it("moves the highlight to the clicked row while its route loads", () => {
    const row = (href: string, active: boolean) =>
      isSidebarRowActive({
        active,
        href,
        pending,
        pathname: "/mail/u/0/inbox",
      });
    expect(row("/account-1/home", false)).toBe(true);
    expect(row("/mail/u/0/inbox", true)).toBe(false);
  });

  it("lets the open view decide again once the address has changed", () => {
    expect(
      isSidebarRowActive({
        active: false,
        href: "/account-1/home",
        pending,
        pathname: "/mail/u/0/sent",
      }),
    ).toBe(false);
    expect(
      isSidebarRowActive({
        active: true,
        href: "/mail/u/0/sent",
        pending,
        pathname: "/mail/u/0/sent",
      }),
    ).toBe(true);
  });
});

describe("usePendingNavigation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("lets go of a navigation that never leaves, such as one sent back", () => {
    const { result } = renderHook(() =>
      usePendingNavigation("/mail/u/0/inbox"),
    );
    act(() => result.current.start("/account-1/home"));
    expect(result.current.pending?.href).toBe("/account-1/home");

    act(() => vi.advanceTimersByTime(10_000));
    expect(result.current.pending).toBeNull();
  });

  it("lets go once the address changes", () => {
    const { result, rerender } = renderHook(
      ({ pathname }) => usePendingNavigation(pathname),
      { initialProps: { pathname: "/mail/u/0/inbox" } },
    );
    act(() => result.current.start("/account-1/home"));
    rerender({ pathname: "/account-1/home" });
    expect(result.current.pending).toBeNull();
  });
});
