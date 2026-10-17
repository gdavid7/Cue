import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The session-expired redirect is once per page, so each test loads a fresh
// copy of the modules that hold that state.
async function loadPage({ signedIn = true } = {}) {
  vi.resetModules();
  const { swrFetcher } = await import("./swr-fetcher");
  const { onSWRErrorRetry } = await import("@/utils/swr");
  const session = await import("@/utils/session-expired");
  if (signedIn) session.armSessionExpiredRedirect();
  // Only now: the modules above read server env when they see a window.
  vi.stubGlobal("window", {
    location: {
      origin: "https://app.example",
      pathname: "/acc-1/mail",
      search: "?view=inbox",
      hash: "",
      assign,
    },
  });
  return { swrFetcher, onSWRErrorRetry, ...session };
}

const assign = vi.fn();

// The first load compiles the app's error and logging stack.
beforeAll(async () => {
  await loadPage({ signedIn: false });
  vi.unstubAllGlobals();
}, 60_000);

beforeEach(() => {
  assign.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () =>
      Response.json(
        {
          error: "Unauthorized",
          errorCode: "SESSION_EXPIRED",
          isKnownError: true,
        },
        { status: 401 },
      ),
    ),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("swrFetcher with an expired session", () => {
  it("sends a burst of signed-out requests to log in once, back to this page", async () => {
    const { swrFetcher } = await loadPage();

    const results = await Promise.allSettled(
      Array.from({ length: 9 }, (_, index) =>
        swrFetcher(`/api/panel-${index}`, undefined, "acc-1"),
      ),
    );

    expect(results.every((result) => result.status === "rejected")).toBe(true);
    expect(assign).toHaveBeenCalledTimes(1);
    expect(assign).toHaveBeenCalledWith(
      `/login?next=${encodeURIComponent("/acc-1/mail?view=inbox")}`,
    );
  });

  it("stops SWR from retrying a signed-out request", async () => {
    const { swrFetcher, onSWRErrorRetry } = await loadPage();
    const error = await swrFetcher("/api/panel", undefined, "acc-1").catch(
      (caught: unknown) => caught,
    );
    const revalidate = vi.fn();

    onSWRErrorRetry(
      error,
      "/api/panel",
      // biome-ignore lint/suspicious/noExplicitAny: SWR's full config is irrelevant here
      {} as any,
      revalidate,
      { retryCount: 1, dedupe: true },
    );

    expect(error).toMatchObject({ status: 401 });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("waits for the user while a composer is open, then signs in once when asked", async () => {
    const { swrFetcher, holdSessionExpiredRedirect } = await loadPage();
    const prompt = vi.fn();
    holdSessionExpiredRedirect(prompt);

    await Promise.allSettled([
      swrFetcher("/api/a", undefined, "acc-1"),
      swrFetcher("/api/b", undefined, "acc-1"),
      swrFetcher("/api/c", undefined, "acc-1"),
    ]);

    expect(assign).not.toHaveBeenCalled();
    expect(prompt).toHaveBeenCalledTimes(1);

    const signIn = prompt.mock.calls[0][0] as () => void;
    signIn();
    signIn();
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("never sends a public page's signed-out visitor to log in", async () => {
    const { swrFetcher } = await loadPage({ signedIn: false });

    await swrFetcher("/api/user/me").catch(() => undefined);

    expect(assign).not.toHaveBeenCalled();
  });
});
