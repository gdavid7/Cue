import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";
import { enqueueDigestItem } from "./index";

vi.mock("@/utils/queue/dispatch", () => ({
  enqueueBackgroundJob: vi.fn().mockResolvedValue("qstash"),
}));

describe("enqueueDigestItem", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues only ids, never the message's addresses, subject or body", async () => {
    await enqueueDigestItem({
      email: {
        id: "message-1",
        threadId: "thread-1",
        headers: {
          from: "Sender <sender@example.com>",
          to: "user@example.com",
          subject: "Quarterly numbers",
          date: "",
        },
        textPlain: "The numbers are in.",
        snippet: "The numbers are in.",
      } as never,
      emailAccountId: "account-1",
      actionId: "action-1",
      logger: createTestLogger(),
    });

    const [{ body }] = vi.mocked(enqueueBackgroundJob).mock.calls[0];
    expect(body).toEqual({
      emailAccountId: "account-1",
      actionId: "action-1",
      messageId: "message-1",
      threadId: "thread-1",
    });
  });
});
