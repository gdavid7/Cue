import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REFRESH_PATH = "/api/auth/get-session?disableCookieCache=true";

beforeEach(() => {
  vi.resetModules();
});

afterEach(() => {
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

  it("returns the second 401 without refreshing or retrying again", async () => {
    const server = stubServer({ refresh: "ok", alwaysExpired: true });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const response = await fetchWithSessionRetry("/api/panel");

    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      errorCode: "SESSION_EXPIRED",
    });
    expect(server.callsTo("/api/panel")).toBe(2);
    expect(server.refreshCalls()).toBe(1);
  });

  it("does not retry when the session cannot be refreshed", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    const responses = await Promise.all([
      fetchWithSessionRetry("/api/a"),
      fetchWithSessionRetry("/api/b"),
    ]);

    expect(responses.map((response) => response.status)).toEqual([401, 401]);
    expect(server.callsTo("/api/a")).toBe(1);
    expect(server.callsTo("/api/b")).toBe(1);
    expect(server.refreshCalls()).toBe(1);
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

// A server whose first request per path finds the session missing; a
// refresh that succeeds makes later requests pass.
function stubServer({
  refresh,
  alwaysExpired = false,
  plainUnauthorized = false,
}: {
  refresh: "ok" | "signed-out";
  alwaysExpired?: boolean;
  plainUnauthorized?: boolean;
}) {
  const calls: { url: string; body: unknown }[] = [];
  let refreshed = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === REFRESH_PATH) {
        calls.push({ url, body: undefined });
        // Let the rest of a burst reach the refresh while it is in flight.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (refresh === "signed-out") return Response.json(null);
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
    refreshCalls: () =>
      calls.filter((call) => call.url === REFRESH_PATH).length,
    callsTo: (url: string) => calls.filter((call) => call.url === url).length,
    bodiesTo: (url: string) =>
      calls.filter((call) => call.url === url).map((call) => call.body),
  };
}
