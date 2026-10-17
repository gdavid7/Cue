import { afterEach, describe, expect, it, vi } from "vitest";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { createMailHttpRequest } from "./http";

describe("createMailHttpRequest", () => {
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
    });
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
});
