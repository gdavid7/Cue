import { describe, expect, it } from "vitest";
import type { MailWaitingSummary } from "@inboxzero/mail-core/engine";
import {
  CHANGES_WAITING_AFTER_MS,
  hasDeliverableChanges,
  hasPendingChanges,
  summarizeWaitingChanges,
} from "@/utils/mail-engine/changes-waiting";

const NOW = 1_000_000;
const ONLINE = { nowMs: NOW, online: true };

describe("summarizeWaitingChanges", () => {
  it("stays quiet while changes are still on their normal way", () => {
    const summary = account([
      group({ oldestWaitingAtMs: NOW - CHANGES_WAITING_AFTER_MS + 1000 }),
    ]);
    expect(summarizeWaitingChanges([summary], ONLINE)).toEqual([]);
    expect(hasPendingChanges([summary])).toBe(true);
  });

  it("reports changes that have waited past the threshold, by kind", () => {
    const [summary] = summarizeWaitingChanges(
      [
        account([
          group({
            count: 2,
            oldestWaitingAtMs: NOW - CHANGES_WAITING_AFTER_MS,
          }),
          group({ status: "executing", kind: "send", changeKind: null }),
        ]),
      ],
      ONLINE,
    );
    expect(summary).toEqual({
      accountId: "account-1",
      state: "waiting",
      count: 3,
      kinds: [
        { label: "Archive", count: 2 },
        { label: "Send", count: 1 },
      ],
    });
  });

  it("calls changes the provider pushed back retrying", () => {
    const [summary] = summarizeWaitingChanges(
      [
        account([
          group({
            status: "retry_wait",
            changeKind: "set_membership",
            membership: "category",
            on: false,
            oldestWaitingAtMs: 0,
          }),
        ]),
      ],
      ONLINE,
    );
    expect(summary?.state).toBe("retrying");
    expect(summary?.kinds).toEqual([{ label: "Remove category", count: 1 }]);
  });

  it("shows a signed-out account at once, even with nothing waiting", () => {
    const summaries = summarizeWaitingChanges(
      [{ ...account([]), connection: "blocked_auth" }],
      ONLINE,
    );
    expect(summaries).toEqual([
      { accountId: "account-1", state: "reconnect", count: 0, kinds: [] },
    ]);
    expect(hasDeliverableChanges(summaries)).toBe(false);
  });

  it("polls a signed-out account with nothing waiting at the idle pace", () => {
    const signedOut: MailWaitingSummary = {
      ...account([]),
      connection: "blocked_auth",
    };
    expect(hasPendingChanges([signedOut])).toBe(false);
    expect(
      hasPendingChanges([
        { ...signedOut, groups: [group({ status: "blocked_auth" })] },
      ]),
    ).toBe(true);
  });

  it("counts changes held for a connection only while offline", () => {
    const summary = account([
      group({
        kind: "send",
        changeKind: null,
        heldOffline: true,
        oldestWaitingAtMs: 0,
      }),
    ]);
    expect(summarizeWaitingChanges([summary], ONLINE)).toEqual([]);
    expect(
      summarizeWaitingChanges([summary], { nowMs: NOW, online: false }),
    ).toEqual([expect.objectContaining({ count: 1, state: "waiting" })]);
  });
});

function account(groups: MailWaitingSummary["groups"]): MailWaitingSummary {
  return {
    accountId: "account-1",
    connection: "ready",
    oldestWaitingAtMs: groups.length
      ? Math.min(...groups.map((item) => item.oldestWaitingAtMs))
      : null,
    groups,
  };
}

function group(
  overrides: Partial<MailWaitingSummary["groups"][number]>,
): MailWaitingSummary["groups"][number] {
  return {
    status: "queued",
    kind: "conversations",
    changeKind: "archive",
    on: null,
    membership: null,
    heldOffline: false,
    count: 1,
    oldestWaitingAtMs: NOW - 60_000,
    ...overrides,
  };
}
