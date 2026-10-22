// @vitest-environment jsdom

import { beforeEach, describe, expect, it } from "vitest";
import {
  clearBrowserCaches,
  clearBrowserCachesForAccount,
  resetBrowserCacheForTesting,
  setBrowserCacheUser,
} from "@/utils/browser-cache";
import {
  dismissWaitingOnYou,
  isWaitingOnYouDismissed,
} from "./use-waiting-on-you";

const ROW = { conversationId: "t1", messageId: "m1" };

describe("Waiting on you dismissals", () => {
  beforeEach(() => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user-1");
  });

  it("keeps a dismissal for that account and message only", () => {
    dismissWaitingOnYou("account-a", ROW);

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(true);
    expect(isWaitingOnYouDismissed("account-b", ROW)).toBe(false);
    // A newer message brings the conversation back.
    expect(
      isWaitingOnYouDismissed("account-a", { ...ROW, messageId: "m2" }),
    ).toBe(false);
  });

  it("forgets dismissals on sign-out", () => {
    dismissWaitingOnYou("account-a", ROW);

    clearBrowserCaches();
    setBrowserCacheUser("user-1");

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(false);
  });

  it("forgets a removed account's dismissals only", () => {
    dismissWaitingOnYou("account-a", ROW);
    dismissWaitingOnYou("account-b", ROW);

    clearBrowserCachesForAccount("account-a");

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(false);
    expect(isWaitingOnYouDismissed("account-b", ROW)).toBe(true);
  });

  it("keeps another user's dismissals from showing", () => {
    dismissWaitingOnYou("account-a", ROW);

    setBrowserCacheUser("user-2");

    expect(isWaitingOnYouDismissed("account-a", ROW)).toBe(false);
  });
});
