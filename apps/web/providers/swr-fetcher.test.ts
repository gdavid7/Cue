import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { swrFetcher } from "./swr-fetcher";

const assign = vi.fn();
const toasts = vi.hoisted(() => ({ toastError: vi.fn() }));
vi.mock("@/components/Toast", () => toasts);
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
  vi.useRealTimers();
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

  it("signs out once and sends nothing more when later revalidations come in", async () => {
    const { swrFetcher } = await loadPage();
    const burst = () =>
      Promise.allSettled(
        Array.from({ length: 6 }, (_, index) =>
          swrFetcher(`/api/panel-${index}`, undefined, "acc-1"),
        ),
      );

    await burst();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    const later = await burst();

    expect(later.every((result) => result.status === "rejected")).toBe(true);
    expect(later[0]).toMatchObject({ reason: { status: 401 } });
    // Six requests and one refresh; the later burst never left the page.
    expect(fetch).toHaveBeenCalledTimes(7);
    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("keeps the page when a refreshed session lets the request through", async () => {
    let refreshed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/auth/get-session")) {
          refreshed = true;
          return Response.json({ user: { id: "u1" }, session: {} });
        }
        if (refreshed) return Response.json({ panel: "ok" });
        return Response.json(
          { error: "Unauthorized", errorCode: "SESSION_EXPIRED" },
          { status: 401 },
        );
      }),
    );
    const { swrFetcher } = await loadPage();

    await expect(swrFetcher("/api/panel", undefined, "acc-1")).resolves.toEqual(
      { panel: "ok" },
    );
    expect(assign).not.toHaveBeenCalled();
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

  it("takes back a held sign-in prompt when the session comes back, and stays when the composer closes", async () => {
    const { swrFetcher, holdSessionExpiredRedirect, resetSessionGone } =
      await loadPage();
    const prompt = vi.fn();
    const dismiss = vi.fn();
    const beforeRedirect = vi.fn(async () => undefined);
    const release = holdSessionExpiredRedirect({
      prompt,
      dismiss,
      beforeRedirect,
    });
    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);
    expect(prompt).toHaveBeenCalledTimes(1);

    resetSessionGone();
    release();
    await Promise.resolve();

    expect(dismiss).toHaveBeenCalledTimes(1);
    expect(beforeRedirect).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });

  it("sends a later expiry to log in after the session came back", async () => {
    stored.set("session-expired-redirected-at", String(Date.now() - 2000));
    const { swrFetcher, resetSessionGone } = await loadPage();
    // The loop guard keeps this first one on the page.
    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);
    expect(assign).not.toHaveBeenCalled();

    resetSessionGone();
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 60_000);
    await swrFetcher("/api/a", undefined, "acc-1").catch(() => undefined);

    expect(assign).toHaveBeenCalledTimes(1);
  });

  it("never sends a public page's signed-out visitor to log in", async () => {
    const { swrFetcher } = await loadPage({ signedIn: false });

    await swrFetcher("/api/user/me").catch(() => undefined);

    expect(assign).not.toHaveBeenCalled();
  });
});

describe("swrFetcher when a mailbox's grant has expired", () => {
  beforeEach(() => {
    toasts.toastError.mockReset();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json(
          {
            error: "Authorization required. Please grant permissions.",
            errorCode: "NO_REFRESH_TOKEN",
            isKnownError: true,
          },
          { status: 401 },
        ),
      ),
    );
  });

  it("sends the viewed account to its reconnect page", async () => {
    const { swrFetcher } = await loadPage();

    await swrFetcher("/api/labels", undefined, "acc-1", {
      viewedEmailAccountId: "acc-1",
    });

    expect(assign).toHaveBeenCalledExactlyOnceWith(
      "/acc-1/permissions/consent?reason=expired",
    );
    expect(toasts.toastError).not.toHaveBeenCalled();
  });

  it("keeps the page when another account fails, and offers to reconnect that one", async () => {
    const { swrFetcher } = await loadPage();

    const failures = await Promise.allSettled([
      swrFetcher("/api/labels", undefined, "acc-2", {
        viewedEmailAccountId: "acc-1",
      }),
      swrFetcher("/api/folders", undefined, "acc-2", {
        viewedEmailAccountId: "acc-1",
      }),
    ]);

    expect(failures.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(assign).not.toHaveBeenCalled();
    expect(toasts.toastError).toHaveBeenCalledOnce();
    const notice = toasts.toastError.mock.calls[0][0];
    notice.action.onClick();
    expect(assign).toHaveBeenCalledExactlyOnceWith(
      "/acc-2/permissions/consent?reason=expired",
    );
  });

  it("stops asking an account for a route the server refused, until it is rechecked", async () => {
    const { swrFetcher } = await loadPage();
    const ask = (path: string) =>
      swrFetcher(path, undefined, "acc-2").catch((error) => error);
    const fetchMock = vi.mocked(fetch);

    await ask("/api/labels?x=1");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const refused = await ask("/api/labels?x=2");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(refused).toMatchObject({
      status: 401,
      info: { errorCode: "NO_REFRESH_TOKEN" },
    });
    expect(toasts.toastError).toHaveBeenCalledOnce();

    await ask("/api/folders");
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 6 * 60_000);
    await ask("/api/labels");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a refused route", async () => {
    const { swrFetcher, onSWRErrorRetry } = await loadPage();
    const error = await swrFetcher("/api/labels", undefined, "acc-2").catch(
      (error) => error,
    );
    const revalidate = vi.fn();

    onSWRErrorRetry(error, "/api/labels", {} as never, revalidate, {
      retryCount: 1,
      dedupe: true,
    } as never);
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(revalidate).not.toHaveBeenCalled();
  });

  it("never leaves the page for an account read without a viewed account", async () => {
    const { swrFetcher } = await loadPage();

    await swrFetcher("/api/scheduled", undefined, "acc-2").catch(
      () => undefined,
    );

    expect(assign).not.toHaveBeenCalled();
    expect(toasts.toastError).toHaveBeenCalledOnce();
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
  const { resetSessionGone } = await import("@/utils/session-refresh");
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
    resetSessionGone,
    ...session,
  };
}

describe("swrFetcher while signing out", () => {
  it("sends nothing once sign-out started", async () => {
    const { swrFetcher } = await loadPage();
    const { startSigningOut } = await import("@/utils/signing-out");
    startSigningOut();

    const settled = vi.fn();
    swrFetcher("/api/panel", undefined, "acc-1").then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(fetch).not.toHaveBeenCalled();
    expect(settled).not.toHaveBeenCalled();
  });

  it("does not report or act on a 401 that lands after sign-out started", async () => {
    const { swrFetcher } = await loadPage();
    const { startSigningOut } = await import("@/utils/signing-out");
    vi.mocked(fetch).mockImplementationOnce(async () => {
      startSigningOut();
      return Response.json(
        { error: "Unauthorized", errorCode: "SESSION_EXPIRED" },
        { status: 401 },
      );
    });

    const settled = vi.fn();
    swrFetcher("/api/panel", undefined, "acc-1").then(settled, settled);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(settled).not.toHaveBeenCalled();
    expect(assign).not.toHaveBeenCalled();
  });
});
