import { beforeEach, describe, expect, it, vi } from "vitest";
import { summarise } from "@/app/api/ai/summarise/controller";
import { chatCompletionStream } from "@/utils/llms";
import { getSummary } from "@/utils/redis/summary";

const { store } = vi.hoisted(() => ({
  store: new Map<string, { value: string; ex?: number }>(),
}));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: async (key: string) => store.get(key)?.value ?? null,
    set: async (key: string, value: string, options?: { ex?: number }) => {
      store.set(key, { value, ex: options?.ex });
      return "OK";
    },
  },
}));
vi.mock("@/utils/llms", () => ({ chatCompletionStream: vi.fn() }));

describe("summarise", () => {
  beforeEach(() => {
    store.clear();
    vi.clearAllMocks();
  });

  // The route looks a summary up by the email's text before asking the model,
  // so it must be saved under that same text or it never hits.
  it("saves the summary where the route looks it up, for a day", async () => {
    vi.mocked(chatCompletionStream).mockImplementation(async (options) => {
      await options.onEnd?.({ text: "Renewal priced at $48k" } as never);
      return {} as never;
    });

    await summarise({
      text: "Hi Sarah, the renewal is $48,000 per year.",
      userEmail: "me@example.com",
      userAi: { user: {}, userId: "u1", id: "a1" } as never,
    });

    expect(await getSummary("Hi Sarah, the renewal is $48,000 per year.")).toBe(
      "Renewal priced at $48k",
    );
    expect([...store.values()]).toEqual([
      { value: "Renewal priced at $48k", ex: 24 * 60 * 60 },
    ]);
  });
});
