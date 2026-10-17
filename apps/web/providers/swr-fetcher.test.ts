import { afterEach, describe, expect, it, vi } from "vitest";
import { swrFetcher } from "./swr-fetcher";

describe("swrFetcher", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("carries a deferral's Retry-After so the retry can wait it out", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              error: "Gmail is busy for this account. Try again shortly.",
              isKnownError: true,
            }),
            { status: 503, headers: { "Retry-After": "27" } },
          ),
      ),
    );

    await expect(swrFetcher("/api/user/home")).rejects.toMatchObject({
      status: 503,
      retryAfterMs: 27_000,
    });
  });
});
