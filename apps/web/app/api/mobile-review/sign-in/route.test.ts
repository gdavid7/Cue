import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { createMobileReviewSessionMock, rateLimitCounts } = vi.hoisted(() => ({
  createMobileReviewSessionMock: vi.fn(),
  rateLimitCounts: new Map<string, number>(),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    eval: async (_script: string, [key]: string[]) => {
      const count = (rateLimitCounts.get(key) ?? 0) + 1;
      rateLimitCounts.set(key, count);
      return count;
    },
  },
}));

vi.mock("@/utils/mobile-review", () => ({
  createMobileReviewSession: createMobileReviewSessionMock,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithErrorTestMiddleware();
});

import { POST } from "./route";

describe("mobile review sign-in route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitCounts.clear();
    createMobileReviewSessionMock.mockResolvedValue({
      emailAccountId: "account-1",
      sessionCookie: {
        name: "__Secure-better-auth.session_token",
        options: {
          expires: new Date("2026-05-01T00:00:00.000Z"),
          httpOnly: true,
          path: "/",
          sameSite: "lax",
          secure: true,
        },
        value: "signed-session-token",
      },
      userEmail: "review@example.com",
      userId: "user-1",
    });
  });

  it("sets the cookie header without echoing it in the response body", async () => {
    const request = new NextRequest(
      "http://localhost/api/mobile-review/sign-in",
      {
        body: JSON.stringify({
          code: "review-code",
          email: "review@example.com",
        }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );

    const response = await POST(request, {} as never);
    const body = await response.json();

    expect(createMobileReviewSessionMock).toHaveBeenCalledWith({
      code: "review-code",
      email: "review@example.com",
      logger: expect.anything(),
    });
    expect(body).toEqual({ success: true });
    expect(body.setCookie).toBeUndefined();
    expect(response.headers.get("set-cookie")).toContain(
      "__Secure-better-auth.session_token=signed-session-token",
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("rejects sign-in requests without an email", async () => {
    const request = new NextRequest(
      "http://localhost/api/mobile-review/sign-in",
      {
        body: JSON.stringify({ code: "review-code" }),
        headers: {
          "content-type": "application/json",
        },
        method: "POST",
      },
    );

    await expect(POST(request, {} as never)).rejects.toThrow();
    expect(createMobileReviewSessionMock).not.toHaveBeenCalled();
  });

  it("stops checking codes for an address after repeated attempts", async () => {
    createMobileReviewSessionMock.mockRejectedValue(
      new Error("Invalid review access code"),
    );
    const attempt = (ip: string) =>
      POST(
        new NextRequest("http://localhost/api/mobile-review/sign-in", {
          body: JSON.stringify({
            code: "wrong-code",
            email: "review@example.com",
          }),
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": ip,
          },
          method: "POST",
        }),
        {} as never,
      ).catch((error: Error) => error);

    for (let index = 0; index < 50; index++)
      await attempt(`203.0.113.${index}`);
    const callsBeforeLastAttempt =
      createMobileReviewSessionMock.mock.calls.length;
    const lastAttempt = await attempt("198.51.100.1");

    expect(callsBeforeLastAttempt).toBeLessThan(50);
    expect(createMobileReviewSessionMock).toHaveBeenCalledTimes(
      callsBeforeLastAttempt,
    );
    expect(lastAttempt).toMatchObject({ statusCode: 429 });
  });

  it("stops checking codes from one client after repeated attempts", async () => {
    createMobileReviewSessionMock.mockRejectedValue(
      new Error("Invalid review access code"),
    );
    const attempt = (email: string) =>
      POST(
        new NextRequest("http://localhost/api/mobile-review/sign-in", {
          body: JSON.stringify({ code: "wrong-code", email }),
          headers: {
            "content-type": "application/json",
            "x-forwarded-for": "203.0.113.7",
          },
          method: "POST",
        }),
        {} as never,
      ).catch((error: Error) => error);

    for (let index = 0; index < 50; index++)
      await attempt(`review${index}@example.com`);

    expect(createMobileReviewSessionMock.mock.calls.length).toBeLessThan(50);
    expect(await attempt("other@example.com")).toMatchObject({
      statusCode: 429,
    });
  });
});
