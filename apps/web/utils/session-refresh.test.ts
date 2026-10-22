import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const REFRESH_PATH = "/api/auth/get-session?disableCookieCache=true";
const SESSION_CHANNEL = "cue-session";

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal("BroadcastChannel", FakeBroadcastChannel);
  FakeBroadcastChannel.open.clear();
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
    server.signIn();
    page.pageshow({ persisted: true });
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
    server.signIn();
    page.show();
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

  it("checks as soon as the tab is shown, with no request to wait for", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset, page } =
      await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);

    await fetchWithSessionRetry("/api/a");
    server.signIn();
    page.show();

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(server.refreshCalls()).toBe(2);
  });

  it("runs one check at a time however often the tab comes back", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, page } = await openPage();

    await fetchWithSessionRetry("/api/a");
    page.show();
    page.focus();
    page.show();
    await fetchWithSessionRetry("/api/a");

    expect(server.refreshCalls()).toBe(2);
  });

  it("waits a little before a request asks again after a check that could not reach the server", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, page } = await openPage();

    await fetchWithSessionRetry("/api/a");
    server.setRefresh("unreachable");
    page.show();
    await vi.waitFor(() => expect(server.refreshCalls()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.signIn();
    const soon = await fetchWithSessionRetry("/api/a");
    laterThanRefreshReuse();
    const later = await fetchWithSessionRetry("/api/a");

    expect(soon.status).toBe(401);
    expect(later.status).toBe(200);
    expect(server.refreshCalls()).toBe(3);
  });

  it("checks at once when the tab comes back, however recently a check could not reach the server", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset, page } =
      await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);

    await fetchWithSessionRetry("/api/a");
    server.setRefresh("unreachable");
    page.show();
    await vi.waitFor(() => expect(server.refreshCalls()).toBe(2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    server.signIn();
    page.focus();

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
  });

  it("does not wake other tabs when the gate rejects a session get-session still names", async () => {
    stubServer({ refresh: "ok", alwaysExpired: true });
    const { fetchWithSessionRetry, page } = await openPage();
    const heard = listenAsOtherTab();

    await fetchWithSessionRetry("/api/a");
    page.show();
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fetchWithSessionRetry("/api/a");
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(heard).not.toHaveBeenCalled();
  });

  it("tells other tabs once a request gets through after a refresh", async () => {
    stubServer({ refresh: "ok" });
    const { fetchWithSessionRetry } = await openPage();
    const heard = listenAsOtherTab();

    await fetchWithSessionRetry("/api/a");

    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("signed-in"));
  });

  it("marks requests it answers itself while stopped", async () => {
    stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, isAnsweredWhileStopped } = await openPage();

    const sent = await fetchWithSessionRetry("/api/a");
    const answeredHere = await fetchWithSessionRetry("/api/a");

    expect(isAnsweredWhileStopped(sent)).toBe(false);
    expect(isAnsweredWhileStopped(answeredHere)).toBe(true);
  });

  it("leaves without saving or resetting when the session now belongs to someone else", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset, page, expired } =
      await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);
    const beforeRedirect = vi.fn(async () => undefined);
    expired.holdSessionExpiredRedirect({ prompt: vi.fn(), beforeRedirect });

    await fetchWithSessionRetry("/api/a");
    server.signIn("someone-else");
    page.show();
    await vi.waitFor(() => expect(page.assign).toHaveBeenCalledWith("/"));
    const after = await fetchWithSessionRetry("/api/a");

    expect(after.status).toBe(401);
    expect(server.callsTo("/api/a")).toBe(1);
    expect(reset).not.toHaveBeenCalled();
    expect(beforeRedirect).not.toHaveBeenCalled();
  });

  it("does not retry a request on someone else's session", async () => {
    const server = stubServer({ refresh: "ok", refreshUser: "someone-else" });
    const { fetchWithSessionRetry, page } = await openPage();

    const response = await fetchWithSessionRetry("/api/a");

    expect(response.status).toBe(401);
    expect(server.callsTo("/api/a")).toBe(1);
    expect(page.assign).toHaveBeenCalledWith("/");
  });
  it("checks when the browser is back online", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset, page } =
      await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);

    await fetchWithSessionRetry("/api/a");
    server.signIn();
    page.online();

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
  });

  it("checks when another tab opens signed in, so a hidden tab's mail sync wakes", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset } = await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);
    await fetchWithSessionRetry("/api/a");
    server.signIn();

    const otherTab = new BroadcastChannel(SESSION_CHANNEL);
    otherTab.postMessage("signed-in");
    otherTab.close();

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
    expect(server.refreshCalls()).toBe(2);
  });

  it("tells other tabs when a page opens signed in", async () => {
    stubServer({ refresh: "ok" });
    const heard = vi.fn();
    const otherTab = new BroadcastChannel(SESSION_CHANNEL);
    otherTab.onmessage = (event) => heard(event.data);

    await openPage();

    await vi.waitFor(() => expect(heard).toHaveBeenCalledWith("signed-in"));
    otherTab.close();
  });

  it("checks when the page is armed again for a signed-in user", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, onSessionGoneReset, expired } =
      await openPage();
    const reset = vi.fn();
    onSessionGoneReset(reset);
    await fetchWithSessionRetry("/api/a");
    server.signIn();

    expired.disarm();
    expired.armSessionExpiredRedirect();

    await vi.waitFor(() => expect(reset).toHaveBeenCalledTimes(1));
  });

  it("lets a request waiting on the check give up when its signal aborts", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry, page } = await openPage();
    await fetchWithSessionRetry("/api/a");
    page.show();

    const controller = new AbortController();
    const waiting = fetchWithSessionRetry("/api/a", {
      signal: controller.signal,
    });
    controller.abort();

    await expect(waiting).rejects.toThrow();
    expect(server.callsTo("/api/a")).toBe(1);
  });

  it("gives the session check a deadline", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { fetchWithSessionRetry } = await import("./session-refresh");

    await fetchWithSessionRetry("/api/a");

    expect(server.refreshSignals()[0]).toBeInstanceOf(AbortSignal);
  });
});

describe("a mail worker reporting the session gone", () => {
  it("lets the worker send again when a signed-out report crossed the session coming back", async () => {
    stubServer({ refresh: "ok" });
    const { workerFoundSessionGone, fetchWithSessionRetry } = await openPage();

    await expect(workerFoundSessionGone("signed-out")).resolves.toBe(
      "send-again",
    );
    const response = await fetchWithSessionRetry("/api/a");

    expect(response.status).toBe(200);
  });

  it("stops the page too when the session is really gone", async () => {
    const server = stubServer({ refresh: "signed-out" });
    const { workerFoundSessionGone, fetchWithSessionRetry } = await openPage();

    await expect(workerFoundSessionGone("signed-out")).resolves.toBe("stopped");
    await fetchWithSessionRetry("/api/a");

    expect(server.callsTo("/api/a")).toBe(0);
  });

  it("never wakes a worker the gate rejected after its refresh, though get-session names a user", async () => {
    const server = stubServer({ refresh: "ok" });
    const { workerFoundSessionGone } = await openPage();

    await expect(workerFoundSessionGone("rejected")).resolves.toBe("stopped");

    expect(server.refreshCalls()).toBe(0);
  });

  it("asks the server afresh rather than reuse a refresh that already settled", async () => {
    const server = stubServer({ refresh: "ok" });
    const { workerFoundSessionGone, fetchWithSessionRetry } = await openPage();
    await fetchWithSessionRetry("/api/a");
    server.setRefresh("signed-out");

    await expect(workerFoundSessionGone("signed-out")).resolves.toBe("stopped");

    expect(server.refreshCalls()).toBe(2);
  });

  it("neither stops nor wakes on a report when the server cannot be reached", async () => {
    const server = stubServer({ refresh: "unreachable" });
    const { workerFoundSessionGone, fetchWithSessionRetry, page } =
      await openPage();

    await expect(workerFoundSessionGone("signed-out")).resolves.toBe("unknown");
    await fetchWithSessionRetry("/api/b");

    expect(server.callsTo("/api/b")).toBe(1);
    expect(page.assign).not.toHaveBeenCalled();
  });

  it("says why a worker stopped", async () => {
    const signedOut = stubServer({ refresh: "signed-out" });
    const first = await import("./session-refresh");
    await first.fetchWithSessionRetry("/api/a");
    expect(signedOut.refreshCalls()).toBe(1);
    expect(first.sessionStopReason()).toBe("signed-out");

    vi.resetModules();
    stubServer({ refresh: "ok", alwaysExpired: true });
    const second = await import("./session-refresh");
    await second.fetchWithSessionRetry("/api/a");
    expect(second.sessionStopReason()).toBe("rejected");
  });
});

// Another tab of this browser, listening for "signed-in".
function listenAsOtherTab() {
  const heard = vi.fn();
  const otherTab = new BroadcastChannel(SESSION_CHANNEL);
  otherTab.onmessage = (event) => heard(event.data);
  return heard;
}

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
  const disarm = signedIn ? expired.armSessionExpiredRedirect("u1") : () => {};
  const page = {
    assign: window.location.assign,
    online: () => window.dispatchEvent(new Event("online")),
    show: () => window.dispatchEvent(new Event("visibilitychange")),
    focus: () => window.dispatchEvent(new Event("focus")),
    pageshow: ({ persisted }: { persisted: boolean }) =>
      window.dispatchEvent(Object.assign(new Event("pageshow"), { persisted })),
  };
  return { ...refresh, page, expired: { ...expired, disarm } };
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
  refreshUser = "u1",
  alwaysExpired = false,
  plainUnauthorized = false,
}: {
  refresh: "ok" | "signed-out" | "unreachable" | "server-error";
  refreshUser?: string;
  alwaysExpired?: boolean;
  plainUnauthorized?: boolean;
}) {
  const calls: { url: string; body: unknown }[] = [];
  let refreshed = false;
  let mode = refresh;
  let user = refreshUser;
  const refreshSignals: (AbortSignal | null | undefined)[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === REFRESH_PATH) {
        calls.push({ url, body: undefined });
        refreshSignals.push(init?.signal);
        // Let the rest of a burst reach the refresh while it is in flight.
        await new Promise((resolve) => setTimeout(resolve, 5));
        if (mode === "signed-out") return Response.json(null);
        if (mode === "unreachable") throw new TypeError("Failed to fetch");
        if (mode === "server-error")
          return Response.json({ error: "Internal" }, { status: 500 });
        refreshed = true;
        return Response.json({ user: { id: user }, session: {} });
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
    signIn: (as = "u1") => {
      mode = "ok";
      user = as;
    },
    setRefresh: (next: typeof refresh) => {
      mode = next;
    },
    refreshSignals: () => refreshSignals,
    refreshCalls: () =>
      calls.filter((call) => call.url === REFRESH_PATH).length,
    callsTo: (url: string) => calls.filter((call) => call.url === url).length,
    bodiesTo: (url: string) =>
      calls.filter((call) => call.url === url).map((call) => call.body),
  };
}

// Other tabs of this browser. Each test gets its own, and a message reaches
// every other open channel of the name on a later task, as in a browser.
class FakeBroadcastChannel {
  static open = new Set<FakeBroadcastChannel>();
  onmessage: ((event: { data: unknown }) => void) | null = null;
  readonly name: string;
  constructor(name: string) {
    this.name = name;
    FakeBroadcastChannel.open.add(this);
  }
  postMessage(data: unknown) {
    const receivers = [...FakeBroadcastChannel.open].filter(
      (channel) => channel !== this && channel.name === this.name,
    );
    setTimeout(() => {
      for (const channel of receivers) {
        if (FakeBroadcastChannel.open.has(channel))
          channel.onmessage?.({ data });
      }
    }, 0);
  }
  close() {
    FakeBroadcastChannel.open.delete(this);
  }
}
