/** @vitest-environment jsdom */

import { afterEach, describe, expect, it } from "vitest";
import {
  clearLocalMailboxCookie,
  forgetLocalMailbox,
  hasLocalMailbox,
  isLocalMailboxStale,
  LOCAL_MAILBOX_COOKIE,
  localMailboxSyncedAt,
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

  // RL-1: a mailbox opened again after days needs the newest inbox mail
  // fetched for the page, as a first visit does.
  it("records when each account's mailbox last finished a sync", () => {
    const syncedAt = Date.parse("2026-10-16T09:30:00Z");
    markLocalMailboxSynced("acc-1", syncedAt);
    markLocalMailboxSynced("acc-2");

    const value = readCookie();
    expect(localMailboxSyncedAt(value, "acc-1")).toBe(syncedAt);
    expect(localMailboxSyncedAt(value, "acc-2")).toBe(0);
    expect(localMailboxSyncedAt(value, "acc-3")).toBeNull();
    expect(hasLocalMailbox(value, "acc-1")).toBe(true);
  });

  it("moves an account's time forward, never back, and not on every sync", () => {
    const syncedAt = Date.parse("2026-10-19T20:00:00Z");
    markLocalMailboxSynced("acc-1", syncedAt);
    markLocalMailboxSynced("acc-1", syncedAt + 30_000);
    expect(localMailboxSyncedAt(readCookie(), "acc-1")).toBe(syncedAt);

    markLocalMailboxSynced("acc-1", syncedAt + 120_000);
    markLocalMailboxSynced("acc-1", null);
    expect(localMailboxSyncedAt(readCookie(), "acc-1")).toBe(
      syncedAt + 120_000,
    );
  });

  it("reads a cookie from before times were kept as a mailbox of unknown age", () => {
    expect(localMailboxSyncedAt("acc-1.acc-2", "acc-2")).toBe(0);
    expect(isLocalMailboxStale(0)).toBe(true);
  });

  // RL-1 review S2: a browser whose clock ran ahead would otherwise never
  // look stale.
  it("doesn't trust a sync time from the future", () => {
    const now = Date.parse("2026-10-19T20:23:00Z");
    expect(isLocalMailboxStale(now + 60_000, now)).toBe(false);
    expect(isLocalMailboxStale(now + 2 * 3_600_000, now)).toBe(true);
  });

  it("replaces a sync time recorded ahead of the latest sync", () => {
    const syncedAt = Date.parse("2026-10-19T20:00:00Z");
    markLocalMailboxSynced("acc-1", syncedAt + 3 * 3_600_000);
    markLocalMailboxSynced("acc-1", syncedAt);

    expect(localMailboxSyncedAt(readCookie(), "acc-1")).toBe(syncedAt);
  });

  it("calls a mailbox stale once it is a quarter of an hour behind", () => {
    const now = Date.parse("2026-10-19T20:23:00Z");
    expect(isLocalMailboxStale(now - 5 * 60_000, now)).toBe(false);
    expect(isLocalMailboxStale(now - 3 * 24 * 3_600_000, now)).toBe(true);
  });

  it("forgets every account when the local mailbox is wiped", () => {
    markLocalMailboxSynced("acc-1");

    clearLocalMailboxCookie();

    expect(hasLocalMailbox(readCookie(), "acc-1")).toBe(false);
  });

  it("forgets one account when its mail is removed from this browser", () => {
    const syncedAt = Date.parse("2026-10-19T20:00:00Z");
    markLocalMailboxSynced("acc-1");
    markLocalMailboxSynced("acc-2", syncedAt);

    forgetLocalMailbox("acc-1");

    expect(hasLocalMailbox(readCookie(), "acc-1")).toBe(false);
    // The other account keeps when it last caught up.
    expect(localMailboxSyncedAt(readCookie(), "acc-2")).toBe(syncedAt);
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
