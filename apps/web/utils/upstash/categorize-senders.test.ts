import { beforeEach, describe, expect, it, vi } from "vitest";
import { publishToQstashQueue } from "@/utils/upstash";
import { publishToAiCategorizeSendersQueue } from "./categorize-senders";

vi.mock("@/utils/upstash", () => ({
  publishToQstashQueue: vi.fn().mockResolvedValue(undefined),
  listQueues: vi.fn().mockResolvedValue([]),
  deleteQueue: vi.fn(),
}));

describe("publishToAiCategorizeSendersQueue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queues only ids, never sender addresses or names", async () => {
    const senderMessageIds = Array.from({ length: 120 }, (_, i) => `row-${i}`);

    await publishToAiCategorizeSendersQueue({
      emailAccountId: "account-1",
      senderMessageIds,
    });

    const bodies = vi
      .mocked(publishToQstashQueue)
      .mock.calls.map(([options]) => options.body);
    expect(bodies).toHaveLength(3);
    for (const body of bodies) {
      expect(Object.keys(body as object).sort()).toEqual([
        "emailAccountId",
        "senderMessageIds",
      ]);
      expect(JSON.stringify(body)).not.toContain("@");
    }
    expect(
      bodies.flatMap(
        (body) => (body as { senderMessageIds: string[] }).senderMessageIds,
      ),
    ).toEqual(senderMessageIds);
  });
});
