import { describe, expect, it, vi } from "vitest";
import { readOptimisticTriage } from "@/utils/mail-engine/optimistic-triage";
import { applyEngineLabels } from "./apply-engine-labels";

describe("applyEngineLabels", () => {
  it("shows the label and the move out of the inbox before the engine answers", () => {
    const client = createClient();
    client.getDiagnostics.mockReturnValue(new Promise(() => {}));

    const applied = applyEngineLabels({
      client: client as never,
      emailAccountId: "acc-1",
      threadIds: ["t1", "t2"],
      labelId: "Label_1",
      removeFromInbox: true,
    });

    expect(
      readOptimisticTriage(client as never).map((entry) => entry.change),
    ).toEqual(
      expect.arrayContaining([
        { kind: "archive" },
        {
          kind: "set_membership",
          membership: "label",
          id: "Label_1",
          present: true,
        },
      ]),
    );
    expect(applied).toBeInstanceOf(Promise);
  });

  it("labels, then archives, the whole selection in one command each", async () => {
    const client = createClient();

    const result = await applyEngineLabels({
      client: client as never,
      emailAccountId: "acc-1",
      threadIds: ["t1", "t2"],
      labelId: "Label_1",
      removeFromInbox: true,
    });

    expect(
      client.submitConversations.mock.calls.map(([command]) => [
        command.change.kind,
        command.conversations.map(
          (conversation: { conversationId: string }) =>
            conversation.conversationId,
        ),
      ]),
    ).toEqual([
      ["set_membership", ["t1", "t2"]],
      ["archive", ["t1", "t2"]],
    ]);
    expect(result).toEqual({
      succeededThreadIds: ["t1", "t2"],
      failedThreadIds: [],
      error: undefined,
    });
    expect(readOptimisticTriage(client as never)).toEqual([]);
  });

  it("does not archive what could not be labelled, and brings it back", async () => {
    const client = createClient();
    client.submitConversations.mockResolvedValueOnce({
      status: "rejected",
      code: "queue_full",
    });

    const result = await applyEngineLabels({
      client: client as never,
      emailAccountId: "acc-1",
      threadIds: ["t1"],
      labelId: "Label_1",
      removeFromInbox: true,
    });

    expect(client.submitConversations).toHaveBeenCalledTimes(1);
    expect(result.failedThreadIds).toEqual(["t1"]);
    expect(readOptimisticTriage(client as never)).toEqual([]);
  });

  it("reports an engine failure for every conversation not yet done", async () => {
    const client = createClient();
    client.submitConversations
      .mockResolvedValueOnce({ status: "queued" })
      .mockRejectedValueOnce(new Error("worker gone"));

    const result = await applyEngineLabels({
      client: client as never,
      emailAccountId: "acc-1",
      threadIds: ["t1", "t2"],
      labelId: "Label_1",
      removeFromInbox: true,
    });

    expect(result.succeededThreadIds).toEqual([]);
    expect(result.failedThreadIds).toEqual(["t1", "t2"]);
    expect(result.error).toEqual(new Error("worker gone"));
    expect(readOptimisticTriage(client as never)).toEqual([]);
  });

  it("only labels when the conversations stay in the inbox", async () => {
    const client = createClient();

    const result = await applyEngineLabels({
      client: client as never,
      emailAccountId: "acc-1",
      threadIds: ["t1"],
      labelId: "Label_1",
      removeFromInbox: false,
    });

    expect(client.submitConversations).toHaveBeenCalledTimes(1);
    expect(result.succeededThreadIds).toEqual(["t1"]);
  });
});

function createClient() {
  return {
    getDiagnostics: vi.fn().mockResolvedValue({ revision: 4 }),
    submitConversations: vi.fn().mockResolvedValue({ status: "queued" }),
  };
}
