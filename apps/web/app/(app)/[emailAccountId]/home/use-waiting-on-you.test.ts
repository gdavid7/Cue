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
  keepShownOrder,
  rememberShownOrder,
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

describe("keepShownOrder", () => {
  // Newest first, as the store answers: e at 50 down to a at 10.
  const at = (id: string, receivedAtMs: number, messageId = `${id}-1`) => ({
    accountId: "account-a",
    conversationId: id,
    messageId,
    receivedAtMs,
  });
  const ids = (rows: { conversationId: string }[]) =>
    rows.map((row) => row.conversationId);
  const keys = (rows: ReturnType<typeof at>[]) =>
    rows.map(
      (row) => `${row.accountId}:${row.conversationId}:${row.messageId}`,
    );

  it("shows the newest first when nothing showed before", () => {
    expect(
      ids(keepShownOrder([], [at("c", 30), at("b", 20), at("a", 10)], 2)),
    ).toEqual(["c", "b"]);
  });

  it("keeps a row that synced in late below the rows already shown", () => {
    const shown = [at("c", 30), at("a", 10)];
    // b was older mail the store didn't hold yet; it sits between the two.
    const next = [at("c", 30), at("b", 20), at("a", 10)];

    expect(ids(keepShownOrder(keys(shown), next, 5))).toEqual(["c", "a", "b"]);
  });

  it("puts new mail on top and lets the oldest shown row go past the limit", () => {
    const shown = [at("c", 30), at("b", 20)];
    const next = [at("d", 40), at("c", 30), at("b", 20)];

    expect(ids(keepShownOrder(keys(shown), next, 2))).toEqual(["d", "c"]);
  });

  it("moves a conversation with a newer message to the top", () => {
    const shown = [at("c", 30), at("b", 20)];
    const next = [at("b", 45, "b-2"), at("c", 30)];

    expect(ids(keepShownOrder(keys(shown), next, 5))).toEqual(["b", "c"]);
  });

  it("closes the gap a row leaves without reordering the rest", () => {
    const shown = [at("c", 30), at("a", 10), at("b", 20)];
    const next = [at("c", 30), at("b", 20), at("a", 10)].filter(
      (row) => row.conversationId !== "a",
    );

    expect(ids(keepShownOrder(keys(shown), next, 5))).toEqual(["c", "b"]);
  });

  it("puts a row that left and came back, as an undo does, in its place again", () => {
    const all = [at("e", 50), at("d", 40), at("c", 30), at("b", 20)];
    const shown = keepShownOrder([], all, 3);
    const order = rememberShownOrder([], shown, all);
    // c is archived: b fills its place.
    const withoutC = all.filter((row) => row.conversationId !== "c");
    const filled = keepShownOrder(order, withoutC, 3);
    expect(ids(filled)).toEqual(["e", "d", "b"]);

    // The undo brings c back where it was.
    const remembered = rememberShownOrder(order, filled, withoutC);
    expect(ids(keepShownOrder(remembered, all, 3))).toEqual(["e", "d", "c"]);
  });
});
