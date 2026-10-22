import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REFRESH_PATH = "/api/auth/get-session?disableCookieCache=true";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("fetchWithSessionRetry", () => {
  it("recovers a burst of 401s with one session refresh and one retry each", async () => {
    const server = stubServer({ refresh: "ok" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fetchWithSessionRetry(`/api/panel-${index}`),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      new Array(10).fill(200),
    );
    expect(server.refreshCalls()).toBe(1);
    for (let index = 0; index < 10; index++) {
      expect(server.callsTo(`/api/panel-${index}`)).toBe(2);
    }
  });

  it("returns the second 401 without refreshing or retrying again, then sends nothing more", async () => {
    const server = stubServer({ refresh: "ok", alwaysExpired: true });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const response = await fetchWithSessionRetry("/api/panel");
    laterThanRefreshReuse();
    const later = await fetchWithSessionRetry("/api/other");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      errorCode: "SESSION_EXPIRED",
    });
    expect(server.callsTo("/api/panel")).toBe(2);
    expect(later.status).toBe(401);
    expect(server.callsTo("/api/other")).toBe(0);
    expect(server.refreshCalls()).toBe(1);
  });

  it("shares one failed refresh among concurrent 401s and retries none of them", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        fetchWithSessionRetry(`/api/panel-${index}`),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual(
      new Array(10).fill(401),
    );
    expect(server.refreshCalls()).toBe(1);
    for (let index = 0; index < 10; index++) {
      expect(server.callsTo(`/api/panel-${index}`)).toBe(1);
    }
  });

  it("sends nothing once a refresh found no session, however long after", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    await fetchWithSessionRetry("/api/panel");
    laterThanRefreshReuse();
    const later = await Promise.all([
      fetchWithSessionRetry("/api/panel"),
      fetchWithSessionRetry("/api/mail/changes", { method: "POST" }),
    ]);

    expect(later.map((response) => response.status)).toEqual([401, 401]);
    expect(await later[0].json()).toMatchObject({
      errorCode: "SESSION_EXPIRED",
    });
    expect(server.callsTo("/api/panel")).toBe(1);
    expect(server.callsTo("/api/mail/changes")).toBe(0);
    expect(server.refreshCalls()).toBe(1);
  });

  it("keeps sending when the refresh could not reach the server", async () => {
    const server = stubServer({ refresh: "unreachable" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    await fetchWithSessionRetry("/api/panel");
    laterThanRefreshReuse();
    await fetchWithSessionRetry("/api/panel");

    expect(server.callsTo("/api/panel")).toBe(2);
    expect(server.refreshCalls()).toBe(2);
  });

  it("does not refresh for a 401 that lands while signing out", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await import("./session-refresh");
    const { startSigningOut } = await import("./signing-out");
    startSigningOut();

    const response = await fetchWithSessionRetry("/api/panel");

    expect(response.status).toBe(401);
    expect(server.refreshCalls()).toBe(0);
  });

  it("keeps sending when the refresh answers with a server error", async () => {
    const server = stubServer({ refresh: "server-error" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    await fetchWithSessionRetry("/api/panel");
    laterThanRefreshReuse();
    await fetchWithSessionRetry("/api/panel");

    expect(server.callsTo("/api/panel")).toBe(2);
    expect(server.refreshCalls()).toBe(2);
  });

  it("still sends another origin's requests once the session is gone", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    await fetchWithSessionRetry("/api/panel");
    await fetchWithSessionRetry("https://other.example/api");

    expect(server.callsTo("https://other.example/api")).toBe(1);
  });

  it("replays a write the auth gate rejected before it ran", async () => {
    const server = stubServer({ refresh: "ok" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const response = await fetchWithSessionRetry("/api/mail/changes", {
      method: "POST",
      body: JSON.stringify({ cursor: 3 }),
    });

    expect(response.status).toBe(200);
    expect(server.bodiesTo("/api/mail/changes")).toEqual([
      '{"cursor":3}',
      '{"cursor":3}',
    ]);
  });

  it("never retries a 401 that is not a rejected session", async () => {
    const server = stubServer({ refresh: "ok", plainUnauthorized: true });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const response = await fetchWithSessionRetry("/api/thing", {
      method: "DELETE",
    });

    expect(response.status).toBe(401);
    expect(server.callsTo("/api/thing")).toBe(1);
    expect(server.refreshCalls()).toBe(0);
  });

  it("never retries a request whose body cannot be sent twice", async () => {
    const server = stubServer({ refresh: "ok" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const response = await fetchWithSessionRetry("/api/upload", {
      method: "POST",
      body: new ReadableStream(),
      duplex: "half",
    } as RequestInit);

    expect(response.status).toBe(401);
    expect(server.callsTo("/api/upload")).toBe(1);
    expect(server.refreshCalls()).toBe(0);
  });

  it("never retries another origin's 401", async () => {
    const server = stubServer({ refresh: "ok" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const response = await fetchWithSessionRetry("https://other.example/api");

    expect(response.status).toBe(401);
    expect(server.callsTo("https://other.example/api")).toBe(1);
    expect(server.refreshCalls()).toBe(0);
  });
});

describe("fetchWithSessionRetry on a signed-in page", () => {
  it("asks once more after a back/forward-cache restore, even after the first load's pageshow", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, page } = await openPage();

    await fetchWithSessionRetry("/api/panel");
    page.pageshow({ persisted: false });
    await fetchWithSessionRetry("/api/panel");
    page.pageshow({ persisted: true });
    server.signIn();
    const restored = await fetchWithSessionRetry("/api/panel");

    expect(restored.status).toBe(200);
    expect(server.callsTo("/api/panel")).toBe(2);
    expect(server.refreshCalls()).toBe(2);
  });

  it("asks the server once when the tab is shown again, and sends again after a sign-in elsewhere", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset, page } =
      await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);

    await fetchWithSessionRetry("/api/a");
    await fetchWithSessionRetry("/api/a");
    page.show();
    server.signIn();
    const responses = await Promise.all([
      fetchWithSessionRetry("/api/a"),
      fetchWithSessionRetry("/api/b"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(server.refreshCalls()).toBe(2);
    expect(server.callsTo("/api/a")).toBe(2);
    expect(server.callsTo("/api/b")).toBe(1);
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it("sends nothing but one check per return to the tab while the session stays gone", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, page } = await openPage();

    await fetchWithSessionRetry("/api/a");
    page.focus();
    page.show();
    await Promise.all([
      fetchWithSessionRetry("/api/a"),
      fetchWithSessionRetry("/api/b"),
    ]);
    await fetchWithSessionRetry("/api/a");

    expect(server.refreshCalls()).toBe(2);
    expect(server.callsTo("/api/a")).toBe(1);
    expect(server.callsTo("/api/b")).toBe(0);
  });

  it("never stops a public page, where a 401 only means signed out", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await openPage({ signedIn: false });

    await fetchWithSessionRetry("/api/user/me");
    laterThanRefreshReuse();
    await fetchWithSessionRetry("/api/user/me");

    expect(server.callsTo("/api/user/me")).toBe(2);
  });
});

// A browser page: modules load first (they read server env when they see a
// window), then the page's window and document appear.
async function openPage({ signedIn = true } = {}) {
  const refresh = await import("./session-refresh");
  const expired = await import("./session-expired");
  const window = Object.assign(new EventTarget(), {
    location: {
      origin: "https://app.example",
      pathname: "/acc-1/mail",
      search: "",
      hash: "",
      assign: vi.fn(),
    },
    sessionStorage: { getItem: () => null, setItem: () => undefined },
  });
  const document = { visibilityState: "visible" };
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  if (signedIn) expired.armSessionExpiredRedirect();
  const page = {
    show: () => window.dispatchEvent(new Event("visibilitychange")),
    focus: () => window.dispatchEvent(new Event("focus")),
    pageshow: ({ persisted }: { persisted: boolean }) =>
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })),
  };
  return { ...refresh, page };
}

// Past the window in which a burst's stragglers reuse a settled refresh.
function laterThanRefreshReuse() {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + 60_000);
}

// A server whose first request per path finds the session missing; a
// refresh that succeeds makes later requests pass.
function stubServer({
  refresh,
  alwaysExpired = false,
  plainUnauthorized = false,
}: {
  refresh: "ok" | "signed-out" | "unreachable" | "server-error";
  alwaysExpired?: boolean;
  plainUnauthorized?: boolean;
}) {
  const calls: { url: string; body: unknown }[] = [];
  let refreshed = false;
  let mode = refresh;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === REFRESH_PATH) {
        calls.push({ url, body: undefined });
        // Let the rest of a burst reach the refresh while it is in flight.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (mode === "signed-out") return Response.json(null);
        if (mode === "unreachable") throw new TypeError("Failed to fetch");
        if (mode === "server-error")
          return Response.json({ error: "Internal" }, { status: 500 });
        refreshed = true;
        return Response.json({ user: { id: "u1" }, session: {} });
      }
      calls.push({ url, body: init?.body });
      if (plainUnauthorized)
        return Response.json({ error: "Unauthorized" }, { status: 401 });
      if (refreshed && !alwaysExpired) return Response.json({ ok: true });
      return Response.json(
        {
          error: "Unauthorized",
          errorCode: "SESSION_EXPIRED",
          isKnownError: true,
        },
        { status: 401 },
      );
    }),
  );
  return {
    // The user signs in again, in another tab.
    signIn: () => {
      mode = "ok";
    },
    refreshCalls: () =>
      calls.filter((call) => call.url === REFRESH_PATH).length,
    callsTo: (url: string) => calls.filter((call) => call.url === url).length,
    bodiesTo: (url: string) =>
      calls.filter((call) => call.url === url).map((call) => call.body),
  };
}
