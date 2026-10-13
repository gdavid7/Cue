import { describe, expect, it } from "vitest";
import { getInboxInsightRequests } from "./useInboxInsights";

describe("getInboxInsightRequests", () => {
  it("asks each account about its own rows, even when thread ids collide", () => {
    const requests = getInboxInsightRequests([
      item({ emailAccountId: "work", threadId: "t1" }),
      item({ emailAccountId: "personal", threadId: "t1" }),
      item({ emailAccountId: "work", threadId: "t2" }),
    ]);

    expect(
      requests.map((request) => ({
        emailAccountId: request.emailAccountId,
        keys: request.items.map((requestItem) => requestItem.key),
      })),
    ).toEqual([
      { emailAccountId: "personal", keys: ["personal:t1"] },
      { emailAccountId: "work", keys: ["work:t1", "work:t2"] },
    ]);
  });

  it("drops repeated rows and splits an account's rows into pages of 50", () => {
    const items = Array.from({ length: 51 }, (_, index) =>
      item({ emailAccountId: "work", threadId: `t${index}` }),
    );
    const requests = getInboxInsightRequests([...items, items[0]]);

    expect(requests.map((request) => request.items.length)).toEqual([50, 1]);
  });
});

function item({
  emailAccountId,
  threadId,
}: {
  emailAccountId: string;
  threadId: string;
}) {
  return {
    key: `${emailAccountId}:${threadId}`,
    emailAccountId,
    threadId,
    messageId: `${threadId}-latest`,
  };
}
