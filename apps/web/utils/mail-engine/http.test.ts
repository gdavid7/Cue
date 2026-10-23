import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAIL_ENGINE_REVISION,
  MAIL_ENGINE_REVISION_HEADER,
} from "@inboxzero/mail-core/protocol/mail-http";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { SERVER_BUILD_HEADER } from "@/utils/server-build";

let createMailHttpRequest: typeof import("./http").createMailHttpRequest;
let startSigningOut: typeof import("@/utils/signing-out").startSigningOut;

describe("createMailHttpRequest", () => {
  // A session found gone stays gone for the page, so each test starts with a
  // fresh copy of the modules that hold that state.
  beforeEach(async () => {
    vi.resetModules();
    ({ createMailHttpRequest } = await import("./http"));
    ({ startSigningOut } = await import("@/utils/signing-out"));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns attachment bytes without parsing them as JSON", async () => {
    const bytes = new Uint8Array([4, 5, 6]);
    const fetchMock = vi.fn(
      async () =>
        new Response(bytes, {
          status: 200,
          headers: {
            "content-type": "application/octet-stream",
            "content-length": "3",
          },
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const request = createMailHttpRequest("acc-1", vi.fn());
    const result = await request({
      method: "GET",
      path: "/api/mail/v1/accounts/acc-1/attachment-content?messageId=m1&attachmentId=a1",
      signal: new AbortController().signal,
      accept: "bytes",
    });
    expect(result.status).toBe(200);
    expect(result.json).toBeNull();
    expect(result.sizeBytes).toBe(3);
    const chunks: Uint8Array[] = [];
    for await (const chunk of result.bytes ?? []) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(Buffer.from(bytes));
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(init.headers).toMatchObject({
      accept: "application/octet-stream",
      [EMAIL_ACCOUNT_HEADER]: "acc-1",
      // The server paces background sync for engines below its minimum.
      [MAIL_ENGINE_REVISION_HEADER]: String(MAIL_ENGINE_REVISION),
    });
  });

  it("reports the deployment that answered, even on an error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "busy" }), {
            status: 503,
            headers: {
              "content-type": "application/json",
              [SERVER_BUILD_HEADER]: "dpl_new",
            },
          }),
      ),
    );
    const onServerBuild = vi.fn();
    const request = createMailHttpRequest("acc-1", vi.fn(), onServerBuild);
    await request({
      method: "POST",
      path: "/api/mail/v1/accounts/acc-1/enumeration",
      body: {},
      signal: new AbortController().signal,
    });
    expect(onServerBuild).toHaveBeenCalledWith("dpl_new");
  });

  it.each([
    {
      name: "a signed-out app session",
      body: {
        error: "Unauthorized",
        errorCode: "SESSION_EXPIRED",
        isKnownError: true,
      },
      sessionExpired: true,
    },
    {
      name: "a missing mailbox grant",
      body: {
        error: "Authorization required. Please grant permissions.",
        errorCode: "NO_REFRESH_TOKEN",
        isKnownError: true,
      },
      sessionExpired: false,
    },
  ])("tells the engine whether a 401 is $name", async ({
    body,
    sessionExpired,
  }) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json(body, { status: 401 })),
    );
    const onSessionExpired = vi.fn();
    const request = createMailHttpRequest("acc-1", onSessionExpired);

    const result = await request({
      method: "POST",
      path: "/api/mail/v1/accounts/acc-1/changes",
      body: {},
      signal: new AbortController().signal,
    });

    expect(result.status).toBe(401);
    expect(Boolean(result.sessionExpired)).toBe(sessionExpired);
    expect(onSessionExpired).toHaveBeenCalledTimes(sessionExpired ? 1 : 0);
  });

  it("reports a stop once, and never for the 401s it then answers itself", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        url.startsWith("/api/auth/get-session")
          ? Response.json(null)
          : Response.json({ errorCode: "SESSION_EXPIRED" }, { status: 401 }),
      ),
    );
    const onSessionExpired = vi.fn();
    const request = createMailHttpRequest("acc-1", onSessionExpired);
    const send = () =>
      request({
        method: "POST",
        path: "/api/mail/v1/accounts/acc-1/changes",
        body: {},
        signal: new AbortController().signal,
      });

    const first = await send();
    const second = await send();

    expect(onSessionExpired).toHaveBeenCalledTimes(1);
    expect(onSessionExpired).toHaveBeenCalledWith("signed-out");
    expect(first.sessionExpired).toBe(true);
    expect(second.sessionExpired).toBe(true);
  });

  it("does not report a stop when the refresh could not reach the server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.startsWith("/api/auth/get-session"))
          throw new TypeError("Failed to fetch");
        return Response.json({ errorCode: "SESSION_EXPIRED" }, { status: 401 });
      }),
    );
    const onSessionExpired = vi.fn();

    const result = await createMailHttpRequest(
      "acc-1",
      onSessionExpired,
    )({
      method: "POST",
      path: "/api/mail/v1/accounts/acc-1/changes",
      body: {},
      signal: new AbortController().signal,
    });

    expect(result.sessionExpired).toBe(true);
    expect(onSessionExpired).not.toHaveBeenCalled();
  });

  it("does not treat a 401 during sign-out as an expired session", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        Response.json({ errorCode: "SESSION_EXPIRED" }, { status: 401 }),
      ),
    );
    const onSessionExpired = vi.fn();
    startSigningOut();

    const result = await createMailHttpRequest(
      "acc-1",
      onSessionExpired,
    )({
      method: "POST",
      path: "/api/mail/v1/accounts/acc-1/changes",
      body: {},
      signal: new AbortController().signal,
    });

    expect(onSessionExpired).not.toHaveBeenCalled();
    expect(Boolean(result.sessionExpired)).toBe(false);
  });
});
