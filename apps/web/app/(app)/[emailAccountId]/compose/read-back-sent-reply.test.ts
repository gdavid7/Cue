import { describe, expect, it, vi } from "vitest";
import { readBackSentReply } from "./read-back-sent-reply";

describe("readBackSentReply", () => {
  it("reads the conversation back when the reply went out now", async () => {
    const client = fakeClient();
    await readBackSentReply({
      client,
      accountId: "account",
      threadId: "thread",
      sendAt: null,
    });
    expect(client.ensureConversationMessages).toHaveBeenCalledWith({
      accountId: "account",
      conversationId: "thread",
    });
  });

  it("leaves a reply scheduled for later to its delivery", async () => {
    const client = fakeClient();
    await readBackSentReply({
      client,
      accountId: "account",
      threadId: "thread",
      sendAt: "2026-10-20T09:00:00.000Z",
    });
    expect(client.ensureConversationMessages).not.toHaveBeenCalled();
  });

  it("does not fail the send when the conversation can't be read", async () => {
    const client = fakeClient();
    client.ensureConversationMessages.mockRejectedValue(new Error("offline"));
    await expect(
      readBackSentReply({
        client,
        accountId: "account",
        threadId: "thread",
        sendAt: null,
      }),
    ).resolves.toBeUndefined();
  });
});

function fakeClient() {
  return {
    ensureConversationMessages: vi.fn().mockResolvedValue({
      status: "complete",
    }),
  };
}
