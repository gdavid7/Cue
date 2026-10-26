import { describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { undoConversationChange } from "@/utils/mail-engine/undo-change";

describe("undoConversationChange", () => {
  it("cancels a change still waiting instead of sending a reverse one", async () => {
    const client = fakeClient("cancelled");

    await undoConversationChange({
      client,
      accountId: "acc-1",
      operationId: "archive-1",
      compensations: [
        { conversationIds: ["c1"], change: { kind: "unarchive" } },
      ],
    });

    expect(client.cancelOperation).toHaveBeenCalledWith({
      accountId: "acc-1",
      operationId: "archive-1",
    });
    expect(client.submitConversations).not.toHaveBeenCalled();
  });

  it("sends each reverse change of a sent one at interactive priority", async () => {
    const client = fakeClient("too_late");

    await undoConversationChange({
      client,
      accountId: "acc-1",
      operationId: "archive-1",
      compensations: [
        { conversationIds: ["c1"], change: { kind: "unarchive" } },
        { conversationIds: ["c2"], change: { kind: "restore_from_trash" } },
      ],
    });

    expect(client.submitConversations).toHaveBeenCalledTimes(2);
    for (const [command] of vi.mocked(client.submitConversations).mock.calls) {
      expect(command).toMatchObject({ priority: "interactive" });
    }
  });
});

function fakeClient(cancelStatus: "cancelled" | "too_late") {
  const revision = { databaseEpoch: "e1", sequence: 1 };
  return {
    cancelOperation: vi.fn(async () =>
      cancelStatus === "cancelled"
        ? { status: "cancelled" as const, revision }
        : { status: "too_late" as const },
    ),
    getDiagnostics: vi.fn(async () => ({ revision })),
    submitConversations: vi.fn(async () => ({
      status: "queued" as const,
      operation: { accountId: "acc-1", operationId: "undo" },
      revision,
    })),
  } as unknown as MailClient & {
    cancelOperation: ReturnType<typeof vi.fn>;
    submitConversations: ReturnType<typeof vi.fn>;
  };
}
