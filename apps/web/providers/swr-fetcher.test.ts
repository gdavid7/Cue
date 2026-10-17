import { afterEach, describe, expect, it, vi } from "vitest";
import { swrFetcher } from "./swr-fetcher";

describe("swrFetcher Retry-After", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("carries a deferral's wait in seconds so the retry can wait it out", async () => {
    deferWith("27");
    await expect(failure()).resolves.toMatchObject({
      status: 503,
      retryAfterMs: 27_000,
    });
  });

  it("reads an HTTP date as the time left until it", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-17T09:00:00Z"),
      toFake: ["Date"],
    });
    deferWith("Sat, 17 Oct 2026 09:00:30 GMT");
    await expect(failure()).resolves.toMatchObject({ retryAfterMs: 30_000 });
  });

  it("reads a date already past as no wait", async () => {
    vi.useFakeTimers({
      now: new Date("2026-10-17T09:00:00Z"),
      toFake: ["Date"],
    });
    deferWith("Sat, 17 Oct 2026 08:59:00 GMT");
    await expect(failure()).resolves.toMatchObject({ retryAfterMs: 0 });
  });

  it("reads 0 as no wait", async () => {
    deferWith("0");
    await expect(failure()).resolves.toMatchObject({ retryAfterMs: 0 });
  });

  it.each([
    "-5",
    "soon",
    "1.5x",
  ])("ignores a malformed value (%s)", async (value) => {
    deferWith(value);
    const error = await failure();
    expect(error).toMatchObject({ status: 503 });
    expect((error as { retryAfterMs?: number }).retryAfterMs).toBeUndefined();
  });
});

function deferWith(retryAfter: string) {
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: "Gmail is busy for this account. Try again shortly.",
            isKnownError: true,
          }),
          { status: 503, headers: { "Retry-After": retryAfter } },
        ),
    ),
  );
}

async function failure() {
  try {
    await swrFetcher("/api/user/home");
  } catch (error) {
    return error;
  }
  throw new Error("Expected the fetch to fail");
}
