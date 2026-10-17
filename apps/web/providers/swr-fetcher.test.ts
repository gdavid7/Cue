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
  const { assertActionSucceeded, getActionErrorMessage } = await import(
    "@/utils/error"
  );
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
    sessionStorage,
  });
  return {
    swrFetcher,
    onSWRErrorRetry,
    assertActionSucceeded,
    getActionErrorMessage,
    ...session,
  };
}

const assign = vi.fn();
const stored = new Map<string, string>();
const sessionStorage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => {
    stored.set(key, value);
  },
};

// The first load compiles the app's error and logging stack.
beforeAll(async () => {
  await loadPage({ signedIn: false });
  vi.unstubAllGlobals();
}, 60_000);

beforeEach(() => {
  assign.mockReset();
  stored.clear();
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

    onSWRErrorRetry(error, "/api/panel", {} as any, revalidate, {
      retryCount: 1,
      dedupe: true,
    });

    expect(error).toMatchObject({ status: 401 });
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("waits for the user while a composer is open, then saves and signs in once when asked", async () => {
    const { swrFetcher, holdSessionExpiredRedirect } = await loadPage();
    const prompt = vi.fn();
    const beforeRedirect = vi.fn(async () => {
      expect(assign).not.toHaveBeenCalled();
    });
    holdSessionExpiredRedirect({ prompt, beforeRedirect });

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
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
    expect(beforeRedirect).toHaveBeenCalled();
  });

  it("saves the draft before leaving when the composer closes while sign-in waits", async () => {
    const { swrFetcher, holdSessionExpiredRedirect } = await loadPage();
    let finishSave = () => {};
    const beforeRedirect = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishSave = resolve;
        }),
    );
    const release = holdSessionExpiredRedirect({
      prompt: vi.fn(),
      beforeRedirect,
    });
    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);

    release();
    expect(beforeRedirect).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    expect(assign).not.toHaveBeenCalled();

    finishSave();
    await vi.waitFor(() => expect(assign).toHaveBeenCalledTimes(1));
  });

  it("never sends a public page's signed-out visitor to log in", async () => {
    const { swrFetcher } = await loadPage({ signedIn: false });

    await swrFetcher("/api/user/me").catch(() => undefined);

    expect(assign).not.toHaveBeenCalled();
  });
});

describe("session-expired redirect loop guard", () => {
  it("does not redirect again within seconds of the last redirect", async () => {
    stored.set("session-expired-redirected-at", String(Date.now() - 2000));
    const { swrFetcher } = await loadPage();

    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);

    expect(assign).not.toHaveBeenCalled();
  });

  it("redirects and records the time once the last redirect is old", async () => {
    stored.set("session-expired-redirected-at", String(Date.now() - 60_000));
    const { swrFetcher } = await loadPage();

    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);

    expect(assign).toHaveBeenCalledTimes(1);
    expect(
      Date.now() - Number(stored.get("session-expired-redirected-at")),
    ).toBeLessThan(1000);
  });

  it("still redirects when session storage is unavailable", async () => {
    const { swrFetcher } = await loadPage();
    vi.stubGlobal("window", {
      location: { ...window.location },
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });

    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);

    expect(assign).toHaveBeenCalledTimes(1);
  });
});

describe("server action errors from a signed-out session", () => {
  it("sends the user to log in when an action's error is read", async () => {
    const { getActionErrorMessage, SESSION_EXPIRED_MESSAGE } = await loadPage();

    expect(
      getActionErrorMessage({ serverError: SESSION_EXPIRED_MESSAGE }),
    ).toBe(SESSION_EXPIRED_MESSAGE);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("sends the user to log in when an action is asserted to have succeeded", async () => {
    const { assertActionSucceeded, SESSION_EXPIRED_MESSAGE } = await loadPage();

    expect(() =>
      assertActionSucceeded({ serverError: SESSION_EXPIRED_MESSAGE }),
    ).toThrow(SESSION_EXPIRED_MESSAGE);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("leaves other refusals on the page", async () => {
    const { getActionErrorMessage } = await loadPage();

    getActionErrorMessage({ serverError: "Unauthorized" });

    expect(assign).not.toHaveBeenCalled();
  });
});
