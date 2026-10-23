import { describe, expect, it } from "vitest";
import type { MailDiagnostics } from "@inboxzero/mail-core/engine";
import {
  CHANGES_WAITING_AFTER_MS,
  hasDeliverableChanges,
  hasPendingChanges,
  summarizeWaitingChanges,
} from "@/utils/mail-engine/changes-waiting";

const NOW = 1_000_000;

describe("summarizeWaitingChanges", () => {
  it("stays quiet while changes are still on their normal way", () => {
    const diagnostics = account({
      oldestPendingAtMs: NOW - CHANGES_WAITING_AFTER_MS + 1000,
      commands: [command("queued", "archive")],
    });
    expect(summarizeWaitingChanges([diagnostics], NOW)).toEqual([]);
    expect(hasPendingChanges([diagnostics])).toBe(true);
  });

  it("reports changes that have waited past the threshold, by kind", () => {
    const [summary] = summarizeWaitingChanges(
      [
        account({
          oldestPendingAtMs: NOW - CHANGES_WAITING_AFTER_MS,
          commands: [
            command("queued", "archive"),
            command("executing", "archive"),
            command("queued", null, "send"),
            command("succeeded", "trash"),
          ],
        }),
      ],
      NOW,
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
        account({
          oldestPendingAtMs: 0,
          commands: [command("retry_wait", "set_membership")],
        }),
      ],
      NOW,
    );
    expect(summary?.state).toBe("retrying");
    expect(summary?.kinds).toEqual([{ label: "Label", count: 1 }]);
  });

  it("shows a signed-out account at once, even with nothing waiting", () => {
    const summaries = summarizeWaitingChanges(
      [account({ connection: "blocked_auth", oldestPendingAtMs: null })],
      NOW,
    );
    expect(summaries).toEqual([
      { accountId: "account-1", state: "reconnect", count: 0, kinds: [] },
    ]);
    expect(hasDeliverableChanges(summaries)).toBe(false);
  });

  it("doesn't count a partly applied change as waiting", () => {
    const diagnostics = account({
      oldestPendingAtMs: 0,
      commands: [command("needs_attention", "archive")],
    });
    expect(summarizeWaitingChanges([diagnostics], NOW)).toEqual([]);
    expect(hasPendingChanges([diagnostics])).toBe(false);
  });
});

function account(overrides: Partial<MailDiagnostics>): MailDiagnostics {
  return {
    accountId: "account-1",
    revision: { databaseEpoch: "epoch", sequence: 1 },
    connection: "ready",
    coverage: [],
    pendingOperations: 0,
    uncertainOperations: 0,
    pendingJobs: 0,
    oldestPendingAtMs: null,
    commands: [],
    ...overrides,
  };
}

function command(
  status: MailDiagnostics["commands"][number]["status"],
  changeKind: string | null,
  kind = "conversations",
): MailDiagnostics["commands"][number] {
  return {
    operationId: `${status}-${changeKind}-${kind}-${Math.random()}`,
    status,
    kind,
    changeKind,
    change: changeKind ? { kind: changeKind } : null,
    messageIds: [],
    conversationIds: [],
  };
}
