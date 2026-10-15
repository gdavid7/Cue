/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearLocalMailboxCookie,
  hasLocalMailbox,
  LOCAL_MAILBOX_COOKIE,
  markLocalMailboxSynced,
} from "./local-mailbox-cookie";

afterEach(() => {
  clearLocalMailboxCookie();
});

describe("local mailbox cookie", () => {
  it("records each account whose mailbox this browser has synced", () => {
    markLocalMailboxSynced("acc-1");
    markLocalMailboxSynced("acc-2");
    markLocalMailboxSynced("acc-1");

    const value = readCookie();
    expect(hasLocalMailbox(value, "acc-1")).toBe(true);
    expect(hasLocalMailbox(value, "acc-2")).toBe(true);
    expect(hasLocalMailbox(value, "acc-3")).toBe(false);
  });

  it("forgets every account when the local mailbox is wiped", () => {
    markLocalMailboxSynced("acc-1");

    clearLocalMailboxCookie();

    expect(hasLocalMailbox(readCookie(), "acc-1")).toBe(false);
  });

  it("treats a missing or malformed cookie as no local mailbox", () => {
    expect(hasLocalMailbox(undefined, "acc-1")).toBe(false);
    expect(hasLocalMailbox("acc-10", "acc-1")).toBe(false);
  });

  it("treats a cookie value that is not valid percent-encoding as no local mailbox", () => {
    // The server hands the value over already decoded, so "%25" arrives as "%".
    expect(hasLocalMailbox("%", "acc-1")).toBe(false);
    expect(hasLocalMailbox("acc-1.%E0%A4%A", "acc-1")).toBe(true);
  });
});

function readCookie() {
  return document.cookie
    .split("; ")
    .find((part) => part.startsWith(`${LOCAL_MAILBOX_COOKIE}=`))
    ?.slice(LOCAL_MAILBOX_COOKIE.length + 1);
}
