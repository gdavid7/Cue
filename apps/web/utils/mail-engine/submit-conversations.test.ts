import { describe, expect, it, vi } from "vitest";
import { submitConversationChanges } from "./submit-conversations";

describe("submitConversationChanges", () => {
  it("submits the whole selection as one command", async () => {
    const client = createClient();

    const { accepted } = await submitConversationChanges({
      accountId: "account",
      change: { kind: "archive" },
      client: client as never,
      conversationIds: ["one", "two", "two", "three"],
    });

    expect(client.submitConversations).toHaveBeenCalledTimes(1);
    expect(client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: ["one", "two", "three"].map((conversationId) => ({
          accountId: "account",
          conversationId,
        })),
      }),
    );
    const commandId = client.submitConversations.mock.calls[0][0].commandId;
    expect(accepted).toEqual(
      ["one", "two", "three"].map((conversationId) => ({
        commandId,
        conversationId,
      })),
    );
  });

  it("splits selections larger than the engine's command limit", async () => {
    const client = createClient();
    const conversationIds = Array.from({ length: 501 }, (_, i) => `c${i}`);

    const { accepted } = await submitConversationChanges({
      accountId: "account",
      change: { kind: "archive" },
      client: client as never,
      conversationIds,
    });

    expect(
      client.submitConversations.mock.calls.map(
        ([command]) => command.conversations.length,
      ),
    ).toEqual([500, 1]);
    expect(accepted).toHaveLength(501);
  });

  it("reports a rejected command without accepting its conversations", async () => {
    const client = createClient();
    client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });

    const result = await submitConversationChanges({
      accountId: "account",
      change: { kind: "archive" },
      client: client as never,
      conversationIds: ["one", "two"],
    });

    expect(result).toEqual({ accepted: [], rejectionCodes: ["queue_full"] });
  });

  it("submits snoozes one conversation per command", async () => {
    const client = createClient();

    const { accepted } = await submitConversationChanges({
      accountId: "account",
      change: { kind: "snooze", untilMs: 1 },
      client: client as never,
      conversationIds: ["one", "two"],
    });

    expect(client.submitConversations).toHaveBeenCalledTimes(2);
    expect(new Set(accepted.map((item) => item.commandId)).size).toBe(2);
  });
});

describe("observed revision", () => {
  it("reads the local revision once for a run of commands", async () => {
    const client = createClient();

    for (const conversationId of ["one", "two", "three"]) {
      await submitConversationChanges({
        accountId: "account",
        change: { kind: "archive" },
        client: client as never,
        conversationIds: [conversationId],
      });
    }

    expect(client.getDiagnostics).toHaveBeenCalledTimes(1);
    expect(client.submitConversations).toHaveBeenCalledTimes(3);
  });

  it("rereads the revision and retries once the local mailbox was reset", async () => {
    const client = createClient();
    await submitConversationChanges({
      accountId: "account",
      change: { kind: "archive" },
      client: client as never,
      conversationIds: ["one"],
    });
    client.getDiagnostics.mockResolvedValue({ revision: 5 });
    client.submitConversations.mockResolvedValueOnce({
      status: "rejected",
      code: "stale_selection",
    });

    const result = await submitConversationChanges({
      accountId: "account",
      change: { kind: "archive" },
      client: client as never,
      conversationIds: ["two"],
    });

    expect(result.rejectionCodes).toEqual([]);
    expect(result.accepted.map((item) => item.conversationId)).toEqual(["two"]);
    const [rejected, retried] = client.submitConversations.mock.calls.slice(1);
    expect(rejected[0].observedRevision).toBe(4);
    expect(retried[0]).toEqual({ ...rejected[0], observedRevision: 5 });
  });
});

function createClient() {
  return {
    getDiagnostics: vi.fn().mockResolvedValue({ revision: 4 }),
    submitConversations: vi.fn().mockResolvedValue({ status: "queued" }),
  };
}
