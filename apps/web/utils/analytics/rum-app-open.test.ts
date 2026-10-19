// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { beginRumAction } from "@/utils/analytics/rum-actions";
import {
  classifyAppOpen,
  markRumAccountSwitch,
  resetRumAppOpenForTesting,
  startRumAppOpen,
  takeRumAccountSwitch,
} from "@/utils/analytics/rum-app-open";
import { markLocalMailboxSynced } from "@/utils/mail-engine/local-mailbox-cookie";

vi.mock("@/utils/analytics/rum-actions", () => ({
  beginRumAction: vi.fn(),
}));

describe("classifyAppOpen", () => {
  it("splits cold, returning and fresh sign-in", () => {
    expect(classifyAppOpen({ hasLocalStore: true, justSignedIn: false })).toBe(
      "app_open_returning",
    );
    expect(classifyAppOpen({ hasLocalStore: false, justSignedIn: false })).toBe(
      "app_open_cold",
    );
    expect(classifyAppOpen({ hasLocalStore: false, justSignedIn: true })).toBe(
      "app_open_fresh_sign_in",
    );
  });
});

describe("account switch marker", () => {
  beforeEach(() => sessionStorage.clear());

  it("is handed over once, while it is fresh", () => {
    markRumAccountSwitch();
    const now = Date.now();

    expect(takeRumAccountSwitch(now)).toBeLessThanOrEqual(now);
    expect(takeRumAccountSwitch(now)).toBeNull();
  });

  it("is dropped when old", () => {
    markRumAccountSwitch();

    expect(takeRumAccountSwitch(Date.now() + 3 * 60 * 1000)).toBeNull();
  });
});

describe("startRumAppOpen", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    resetRumAppOpenForTesting();
    document.cookie = "cue-local-mail=; max-age=0; path=/";
  });

  it("times a returning open from navigation start, once", () => {
    markLocalMailboxSynced("acct_1");

    startRumAppOpen("acct_1");
    startRumAppOpen("acct_1");

    expect(beginRumAction).toHaveBeenCalledTimes(1);
    expect(beginRumAction).toHaveBeenCalledWith("app_open_returning", {
      startedAt: 0,
    });
  });

  it("times a browser with no local mailbox as cold", () => {
    startRumAppOpen("acct_1");

    expect(beginRumAction).toHaveBeenCalledWith("app_open_cold", {
      startedAt: 0,
    });
  });

  it("times a page load that follows an account switch as a switch", () => {
    markRumAccountSwitch();

    startRumAppOpen("acct_2");

    expect(beginRumAction).toHaveBeenCalledWith("account_switch_first_row", {
      startedAt: expect.any(Number),
    });
  });
});

describe("startRumAppOpen after a soft navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
    resetRumAppOpenForTesting();
  });

  afterEach(() => vi.restoreAllMocks());

  function loadedAt(url: string) {
    vi.spyOn(performance, "getEntriesByType").mockReturnValue([
      { name: url } as PerformanceEntry,
    ]);
  }

  it("counts the first mount of a page loaded on a mail route", () => {
    loadedAt("https://app.example.com/mail/u/0");

    startRumAppOpen("acct_1");

    expect(beginRumAction).toHaveBeenCalledTimes(1);
  });

  it("does not count a mail screen reached from another page", () => {
    loadedAt("https://app.example.com/settings");

    startRumAppOpen("acct_1");

    expect(beginRumAction).not.toHaveBeenCalled();
  });

  it("clears the account-switch marker when the load is not a mail page", () => {
    markRumAccountSwitch();
    loadedAt("https://app.example.com/settings");

    startRumAppOpen("acct_1");

    expect(beginRumAction).not.toHaveBeenCalled();
    expect(sessionStorage.getItem("cue-rum-account-switch")).toBeNull();
  });
});
