import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rateLimitCounts, aiComposeAssistMock } = vi.hoisted(() => ({
  rateLimitCounts: new Map<string, number>(),
  aiComposeAssistMock: vi.fn(),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    eval: async (_script: string, [key]: string[]) => {
      const count = (rateLimitCounts.get(key) ?? 0) + 1;
      rateLimitCounts.set(key, count);
      return count;
    },
  },
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailAccountTestMiddleware();
});
vi.mock("@/utils/user/get", () => ({
  getEmailAccountWithAi: vi.fn(async () => ({
    id: "account-1",
    userId: "user-1",
    email: "me@example.com",
    user: { aiApiKey: null },
  })),
}));
vi.mock("@/utils/premium/limits", () => ({
  assertHasAiAccess: vi.fn(async () => {}),
}));
vi.mock("@/utils/ai/compose/compose-assist", () => ({
  getComposeAssistContext: vi.fn(async () => ({
    thread: [],
    writingStyle: null,
    learnedWritingStyle: null,
    memories: [],
  })),
  aiComposeAssist: aiComposeAssistMock,
}));

import { POST } from "./route";

describe("compose-assist route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitCounts.clear();
    aiComposeAssistMock.mockImplementation(async () => ({
      toTextStreamResponse: () => new Response("Better text"),
    }));
  });

  it("stops calling the model for an account after a burst of requests", async () => {
    const statuses: number[] = [];
    for (let index = 0; index < 200; index++) {
      const response = await POST(
        new NextRequest("http://localhost/api/ai/compose-assist", {
          body: JSON.stringify({
            mode: "rewrite",
            action: "improve",
            text: "can u send the doc",
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        {} as never,
      );
      statuses.push(response.status);
    }

    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
    expect(aiComposeAssistMock.mock.calls.length).toBeLessThan(200);
  });
});
