import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { permanentRedirect, redirect } from "next/navigation";
import { ZodError, type ZodIssue } from "zod";
import {
  getUnauthorizedReason,
  withError,
  withAuth,
  withAdmin,
  withEmailAccount,
  withEmailProvider,
  type RequestWithAuth,
  type RequestWithEmailAccount,
  type RequestWithEmailProvider,
  type NextHandler,
} from "./middleware";
import {
  getFastRequestSampleRate,
  isFastRequestSampled,
} from "@/utils/request-sampling";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { isAdmin } from "@/utils/admin";
import { captureException, checkCommonErrors, SafeError } from "@/utils/error";
import { createEmailProvider } from "@/utils/email/provider";
import { isProviderRateLimitModeError } from "@/utils/email/rate-limit-mode-error";
import { recordRateLimitFromApiError } from "@/utils/email/rate-limit";
import { getAuditContext } from "@/utils/audit/context";
import { getRequestDeadline } from "@/utils/request-deadline-reader";

const uuidOverride = vi.hoisted(() => ({
  current: undefined as string | undefined,
}));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    default: actual,
    randomUUID: () => uuidOverride.current ?? actual.randomUUID(),
  };
});

vi.mock("better-auth", () => {
  const mockAuthFn = vi.fn();
  return {
    betterAuth: vi.fn(() => ({
      api: { getSession: mockAuthFn },
      signIn: vi.fn(),
      signOut: vi.fn(),
    })),
  };
});

vi.mock("@/utils/auth", () => ({
  auth: vi.fn(),
}));

vi.mock("@/utils/redis");
vi.mock("@/utils/prisma");
vi.mock("@/utils/admin", () => ({
  isAdmin: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: vi.fn(),
}));
vi.mock("@/utils/email/rate-limit", async (importActual) => {
  const actual =
    await importActual<typeof import("@/utils/email/rate-limit")>();
  return {
    recordRateLimitFromApiError: vi.fn(),
    getProviderRateLimitRetryAfterSeconds:
      actual.getProviderRateLimitRetryAfterSeconds,
  };
});
vi.mock("@/utils/email/rate-limit-mode-error", async (importActual) => ({
  ...(await importActual<
    typeof import("@/utils/email/rate-limit-mode-error")
  >()),
  isProviderRateLimitModeError: vi.fn(),
}));

vi.mock("@/utils/error", async (importActual) => {
  const actual = await importActual<typeof import("@/utils/error")>();
  return {
    ...actual,
    captureException: vi.fn(),
    checkCommonErrors: vi.fn(),
  };
});

vi.mock("@/utils/error.server");

const mockAuth = vi.mocked(auth);
const mockCheckCommonErrors = vi.mocked(checkCommonErrors);
const mockCaptureException = vi.mocked(captureException);
const mockIsAdmin = vi.mocked(isAdmin);
const mockCreateEmailProvider = vi.mocked(createEmailProvider);
const mockPrismaEmailAccountFindUnique = vi.mocked(
  prisma.emailAccount.findUnique,
);
const mockIsProviderRateLimitModeError = vi.mocked(
  isProviderRateLimitModeError,
);
const mockRecordRateLimitFromApiError = vi.mocked(recordRateLimitFromApiError);

type RequestWithAuthAndEmail = RequestWithAuth & {
  auth: { emailAccountId: string; email: string };
};

describe("Middleware", () => {
  let mockReq: NextRequest;
  const mockContext = { params: Promise.resolve({}) };

  beforeEach(() => {
    vi.resetAllMocks();
    mockReq = createMockRequest();
  });

  describe("withError", () => {
    it("uses valid UUID v4 request IDs from the request header", async () => {
      const requestId = "123e4567-e89b-42d3-a456-426614174000";
      mockReq = createMockRequest("GET", "http://localhost/test", {
        "x-request-id": requestId,
      });
      const handler = vi.fn(async () =>
        NextResponse.json({ requestId: getAuditContext().requestId }),
      );
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(responseBody.requestId).toBe(requestId);
    });

    it("generates a fresh request ID for invalid request ID headers", async () => {
      mockReq = createMockRequest("GET", "http://localhost/test", {
        "x-request-id": "not-a-valid-request-id",
      });
      const handler = vi.fn(async () =>
        NextResponse.json({ requestId: getAuditContext().requestId }),
      );
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(responseBody.requestId).not.toBe("not-a-valid-request-id");
      expect(responseBody.requestId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });

    it("should call the handler and return its response on success", async () => {
      const mockResponse = NextResponse.json({ success: true });
      const handler = vi.fn().mockResolvedValue(mockResponse);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(handler).toHaveBeenCalledWith(mockReq, mockContext);
      expect(response.status).toBe(200);
      expect(responseBody).toEqual({ success: true });
    });

    it("logs the request path without query parameters", async () => {
      const verificationToken = "google-webhook-secret";
      mockReq = createMockRequest(
        "POST",
        `http://localhost/api/google/webhook?token=${verificationToken}`,
      );
      const consoleLogSpy = vi
        .spyOn(console, "log")
        .mockImplementation(() => {});
      try {
        const wrappedHandler = withError("google/webhook", async (request) => {
          request.logger.info("Processing webhook");
          return NextResponse.json({ ok: true });
        });

        await wrappedHandler(mockReq, mockContext);

        const loggedMessage = consoleLogSpy.mock.calls.flat().join(" ");
        expect(loggedMessage).toContain('"url": "/api/google/webhook"');
        expect(loggedMessage).not.toContain(verificationToken);
      } finally {
        consoleLogSpy.mockRestore();
      }
    });

    describe("request completion line", () => {
      function completionLines(spy: ReturnType<typeof vi.spyOn>) {
        return spy.mock.calls
          .map((args) => String(args[0]))
          .filter((line) => line.includes("Request completed"));
      }

      it("logs a slow request at info under its route's scope, with status and duration", async () => {
        vi.useFakeTimers();
        const consoleLogSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => {});
        try {
          mockReq = createMockRequest(
            "GET",
            "http://localhost/api/threads/thread-123?email=someone%40example.com",
          );
          const wrappedHandler = withError("threads/detail", async () => {
            vi.advanceTimersByTime(1500);
            return NextResponse.json({ ok: true });
          });

          await wrappedHandler(mockReq, mockContext);

          const lines = completionLines(consoleLogSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/^\[threads\/detail\]: Request completed/);
          expect(lines[0]).toContain('"url": "/api/threads/thread-123"');
          expect(lines[0]).not.toContain('"route"');
          expect(lines[0]).toContain('"method": "GET"');
          expect(lines[0]).toContain('"status": 200');
          expect(lines[0]).toContain('"durationMs": 1500');
          expect(lines[0]).not.toContain("someone");
        } finally {
          consoleLogSpy.mockRestore();
          vi.useRealTimers();
        }
      });

      it("says how long the request spent before its handler ran", async () => {
        vi.useFakeTimers();
        const consoleLogSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => {});
        try {
          mockAuth.mockImplementation(async () => {
            vi.advanceTimersByTime(400);
            return { user: { id: "user-1" } } as any;
          });
          const wrappedHandler = withAuth("user/test", async () => {
            vi.advanceTimersByTime(1200);
            return NextResponse.json({ ok: true });
          });

          await wrappedHandler(mockReq, mockContext);

          const lines = completionLines(consoleLogSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain('"durationMs": 1600');
          expect(lines[0]).toContain('"preHandlerMs": 400');
          expect(lines[0]).toContain('"preHandlerDbCalls": 0');
        } finally {
          consoleLogSpy.mockRestore();
          vi.useRealTimers();
        }
      });

      it("logs a request that ends in a 500 at info however fast it was", async () => {
        const consoleLogSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => {});
        const consoleErrorSpy = vi
          .spyOn(console, "error")
          .mockImplementation(() => {});
        try {
          const wrappedHandler = withError("user/home", async () => {
            throw new Error("boom");
          });

          const response = await wrappedHandler(mockReq, mockContext);

          expect(response.status).toBe(500);
          const lines = completionLines(consoleLogSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/^\[user\/home\]: Request completed/);
          expect(lines[0]).toContain('"status": 500');
        } finally {
          consoleLogSpy.mockRestore();
          consoleErrorSpy.mockRestore();
        }
      });

      it("samples fast requests by a server-generated id, ignoring a client x-request-id", async () => {
        const ids = Array.from(
          { length: 400 },
          (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        );
        const sampledId = ids.find((id) => isFastRequestSampled(id, 0.08));
        const skippedId = ids.find((id) => !isFastRequestSampled(id, 0.08));
        expect(sampledId).toBeDefined();
        expect(skippedId).toBeDefined();
        const share = ids.filter((id) => isFastRequestSampled(id, 0.08)).length;
        expect(share / ids.length).toBeGreaterThan(0.03);
        expect(share / ids.length).toBeLessThan(0.15);

        const consoleLogSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => {});
        const wrappedHandler = withError("threads/list", async () =>
          NextResponse.json({ ok: true }),
        );
        const run = async (serverId: string, clientId: string) => {
          uuidOverride.current = serverId;
          await wrappedHandler(
            createMockRequest("GET", "http://localhost/api/threads", {
              "x-request-id": clientId,
            }),
            mockContext,
          );
        };
        try {
          // A client picking an id that would be sampled cannot force a line.
          await run(skippedId as string, sampledId as string);
          expect(completionLines(consoleLogSpy)).toHaveLength(0);

          await run(sampledId as string, skippedId as string);
          const lines = completionLines(consoleLogSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toMatch(/^\[threads\/list\]: Request completed/);
          expect(lines[0]).toContain('"sampled": true');
          expect(lines[0]).toContain('"sampleRate": 0.08');
          expect(lines[0]).toContain('"status": 200');
        } finally {
          uuidOverride.current = undefined;
          consoleLogSpy.mockRestore();
        }
      });

      it("samples polling scopes at a lower rate than other routes", () => {
        expect(getFastRequestSampleRate("mail-stream")).toBe(0.015);
        expect(getFastRequestSampleRate("mail-version")).toBe(0.015);
        expect(getFastRequestSampleRate("mail/v1/enumeration")).toBe(0.015);
        expect(getFastRequestSampleRate("threads/list")).toBe(0.08);
        expect(getFastRequestSampleRate(undefined)).toBe(0.08);
      });

      it.each([
        { redirectTo: redirect, status: 307 },
        { redirectTo: permanentRedirect, status: 308 },
      ])("rethrows a redirect and logs it with its $status status", async ({
        redirectTo,
        status,
      }) => {
        vi.useFakeTimers();
        const consoleLogSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => {});
        try {
          const wrappedHandler = withError("user/home", async () => {
            vi.advanceTimersByTime(1500);
            redirectTo("/login");
          });

          await expect(wrappedHandler(mockReq, mockContext)).rejects.toThrow(
            "NEXT_REDIRECT",
          );

          const lines = completionLines(consoleLogSpy);
          expect(lines).toHaveLength(1);
          expect(lines[0]).toContain(`"status": ${status}`);
        } finally {
          consoleLogSpy.mockRestore();
          vi.useRealTimers();
        }
      });

      it("keeps a fast successful request out of the shipped logs", async () => {
        const consoleLogSpy = vi
          .spyOn(console, "log")
          .mockImplementation(() => {});
        try {
          const wrappedHandler = withError("user/home", async () =>
            NextResponse.json({ ok: true }),
          );

          uuidOverride.current = Array.from(
            { length: 100 },
            (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
          ).find((id) => !isFastRequestSampled(id, 0.08));

          await wrappedHandler(mockReq, mockContext);

          expect(completionLines(consoleLogSpy)).toEqual([]);
        } finally {
          uuidOverride.current = undefined;
          consoleLogSpy.mockRestore();
        }
      });
    });

    it("should return 400 for ZodError", async () => {
      const zodError = new ZodError([
        { path: ["field"], message: "Required" },
      ] as ZodIssue[]);
      const handler = vi.fn().mockRejectedValue(zodError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(responseBody).toEqual({
        error: { issues: zodError.issues },
        isKnownError: true,
      });
    });

    it("should return 400 for SafeError", async () => {
      const safeError = new SafeError("User-friendly message");
      const handler = vi.fn().mockRejectedValue(safeError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(responseBody).toEqual({
        error: "User-friendly message",
        isKnownError: true,
      });
    });

    it("answers a revoked Gmail grant with the reconnect 401, not a 500 or a Sentry event", async () => {
      const revoked = Object.assign(new SafeError("No refresh token"), {
        cause: new Error("invalid_grant: Token has been expired or revoked."),
      });
      const handler = vi.fn().mockRejectedValue(revoked);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(response.status).toBe(401);
      expect(responseBody).toMatchObject({ isKnownError: true });
      expect(responseBody.errorCode).toBeTruthy();
      expect(mockCaptureException).not.toHaveBeenCalled();
    });

    it("should return structured JSON errors for public API SafeError responses", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/v1/rules");
      const safeError = new SafeError("Missing API key", 401);
      const handler = vi.fn().mockRejectedValue(safeError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(response.status).toBe(401);
      expect(responseBody).toEqual({
        error: {
          code: "UNAUTHORIZED",
          message: "Missing API key",
          hint: expect.stringContaining("API-Key"),
        },
      });
    });

    it("should respect SafeError status codes", async () => {
      const safeError = new SafeError("Slow down", 429);
      const handler = vi.fn().mockRejectedValue(safeError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(response.status).toBe(429);
      expect(responseBody).toEqual({
        error: "Slow down",
        isKnownError: true,
      });
    });

    it("should ignore non-error SafeError status codes", async () => {
      const safeError = new SafeError("User-friendly message", 200);
      const handler = vi.fn().mockRejectedValue(safeError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(response.status).toBe(400);
      expect(responseBody).toEqual({
        error: "User-friendly message",
        isKnownError: true,
      });
    });

    it("should handle common errors using checkCommonErrors", async () => {
      const commonError = { message: "API Error", code: 409, type: "Conflict" };
      mockCheckCommonErrors.mockReturnValue(commonError);
      const apiError = new Error("Some API error");
      mockReq = createMockRequest(
        "GET",
        "http://localhost/api/google/webhook?token=webhook-secret",
      );
      const handler = vi.fn().mockRejectedValue(apiError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(checkCommonErrors).toHaveBeenCalledWith(
        apiError,
        "/api/google/webhook",
        expect.anything(),
      );
      expect(response.status).toBe(commonError.code);
      expect(responseBody).toEqual({
        error: commonError.message,
        isKnownError: true,
      });
    });

    it("should still return 429 for rate-limit API errors", async () => {
      const rateLimitError = new Error("Rate limit exceeded");
      const commonError = {
        message: "Gmail error: retry later",
        code: 429,
        type: "Gmail Rate Limit Exceeded",
      };
      mockCheckCommonErrors.mockReturnValue(commonError);
      mockRecordRateLimitFromApiError.mockResolvedValueOnce("google");
      (mockReq as any).auth = { emailAccountId: "acc-456" };

      const handler = vi.fn().mockRejectedValue(rateLimitError);
      const wrappedHandler = withError("labels", handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(mockRecordRateLimitFromApiError).toHaveBeenCalledWith(
        expect.objectContaining({
          apiErrorType: commonError.type,
          error: rateLimitError,
          emailAccountId: "acc-456",
        }),
      );
      expect(response.status).toBe(429);
      expect(responseBody).toEqual({
        error: commonError.message,
        isKnownError: true,
      });
    });

    it("tells the client when to retry a Gmail per-minute quota refusal", async () => {
      const refusal = {
        status: 403,
        errors: [{ reason: "rateLimitExceeded" }],
        message:
          "Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'",
      };
      mockCheckCommonErrors.mockReturnValue({
        message: "Gmail error: retry later",
        code: 429,
        type: "Gmail Rate Limit Exceeded",
      });
      mockRecordRateLimitFromApiError.mockResolvedValueOnce("google");

      const response = await withError(
        "labels",
        vi.fn().mockRejectedValue(refusal),
      )(mockReq, mockContext);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("30");
    });

    it("tells the client when to retry a rate limit on a route with no email account", async () => {
      mockCheckCommonErrors.mockReturnValue({
        message: "Gmail error: retry later",
        code: 429,
        type: "Gmail Rate Limit Exceeded",
      });
      // Nothing to record without an account.
      mockRecordRateLimitFromApiError.mockResolvedValueOnce(null);

      const response = await withError(
        "threads/all",
        vi.fn().mockRejectedValue({
          status: 403,
          errors: [{ reason: "rateLimitExceeded" }],
          message:
            "Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'",
        }),
      )(mockReq, mockContext);

      expect(response.status).toBe(429);
      expect(response.headers.get("Retry-After")).toBe("30");
    });

    it("gives a route's work a deadline under its maxDuration, and none without one", async () => {
      const handler = vi.fn(async () =>
        NextResponse.json({ deadlineAt: getRequestDeadline() ?? null }),
      );

      const startedAt = Date.now();
      const bounded = await withError("test", handler, { maxDuration: 30 })(
        mockReq,
        mockContext,
      );
      const unbounded = await withError("test", handler)(mockReq, mockContext);

      const { deadlineAt } = await bounded.json();
      expect(deadlineAt - startedAt).toBeGreaterThanOrEqual(15_000);
      expect(deadlineAt - startedAt).toBeLessThanOrEqual(21_000);
      await expect(unbounded.json()).resolves.toEqual({ deadlineAt: null });
    });

    it("should return 500 and capture unhandled errors", async () => {
      const unexpectedError = new Error("Something went very wrong");
      mockCheckCommonErrors.mockReturnValue(null);
      mockReq = createMockRequest(
        "GET",
        "http://localhost/api/slack/callback?code=oauth-code&state=oauth-state",
      );
      const handler = vi.fn().mockRejectedValue(unexpectedError);
      const wrappedHandler = withError(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(checkCommonErrors).toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledWith(unexpectedError, {
        extra: { url: "/api/slack/callback" },
      });
      expect(response.status).toBe(500);
      expect(responseBody).toEqual({ error: "An unexpected error occurred" });
    });
  });

  describe("withAuth", () => {
    const mockUserId = "user-123";

    it("should call the handler with auth info if session exists", async () => {
      mockAuth.mockResolvedValue({ user: { id: mockUserId } } as any);
      const handler = vi.fn(async (_req: RequestWithAuth, _ctx: any) =>
        NextResponse.json({ ok: true }),
      );
      const wrappedHandler = withAuth(handler);

      await wrappedHandler(mockReq, mockContext);

      expect(auth).toHaveBeenCalledTimes(1);
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { userId: mockUserId },
        }),
        mockContext,
      );
    });

    it("preserves NextRequest APIs when adding auth info", async () => {
      mockReq = createMockRequest("GET", "http://localhost/test?view=all", {
        cookie: "display=compact",
      });
      mockAuth.mockResolvedValue({ user: { id: mockUserId } } as any);
      const handler = vi.fn(async (request: RequestWithAuth) =>
        NextResponse.json({
          pathname: request.nextUrl.pathname,
          view: request.nextUrl.searchParams.get("view"),
          display: request.cookies.get("display")?.value,
        }),
      );

      const response = await withAuth(handler)(mockReq, mockContext);

      await expect(response.json()).resolves.toEqual({
        pathname: "/test",
        view: "all",
        display: "compact",
      });
    });

    it("answers a missing session with the session-expired 401, not a grant failure", async () => {
      mockAuth.mockResolvedValue(null as any);
      const handler: NextHandler<RequestWithAuth> = vi.fn();
      const wrappedHandler = withAuth(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(auth).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(responseBody).toEqual({
        error: "Unauthorized",
        errorCode: "SESSION_EXPIRED",
        isKnownError: true,
      });
    });

    it("should return 500 if auth throws", async () => {
      const authError = new Error("Session lookup failed");
      mockAuth.mockRejectedValue(authError);
      const handler: NextHandler<RequestWithAuth> = vi.fn();
      const wrappedHandler = withAuth(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(auth).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
      expect(mockCaptureException).toHaveBeenCalledWith(authError, {
        extra: { url: "/test" },
      });
      expect(response.status).toBe(500);
      expect(responseBody).toEqual({
        error: "An unexpected error occurred",
      });
    });
  });

  describe("withAdmin", () => {
    const mockUserId = "user-123";

    it("should call the handler for admin users", async () => {
      mockAuth.mockResolvedValue({ user: { id: mockUserId } } as any);
      prisma.user.findUnique.mockResolvedValue({
        email: "admin@example.com",
      } as any);
      mockIsAdmin.mockReturnValue(true);

      const handler = vi.fn(async (_req: RequestWithAuth, _ctx: any) =>
        NextResponse.json({ ok: true }),
      );
      const wrappedHandler = withAdmin("admin/test", handler);

      await wrappedHandler(mockReq, mockContext);

      expect(auth).toHaveBeenCalledTimes(1);
      expect(prisma.user.findUnique).toHaveBeenCalledWith({
        where: { id: mockUserId },
        select: { email: true },
      });
      expect(mockIsAdmin).toHaveBeenCalledWith({ email: "admin@example.com" });
      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: { userId: mockUserId },
        }),
        mockContext,
      );
    });

    it("should return 403 if user is not admin", async () => {
      mockAuth.mockResolvedValue({ user: { id: mockUserId } } as any);
      prisma.user.findUnique.mockResolvedValue({
        email: "user@example.com",
      } as any);
      mockIsAdmin.mockReturnValue(false);

      const handler: NextHandler<RequestWithAuth> = vi.fn();
      const wrappedHandler = withAdmin("admin/test", handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      expect(responseBody).toEqual({
        error: "Unauthorized",
        isKnownError: true,
      });
    });

    it("should return 401 if session does not exist", async () => {
      mockAuth.mockResolvedValue(null as any);

      const handler: NextHandler<RequestWithAuth> = vi.fn();
      const wrappedHandler = withAdmin("admin/test", handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(prisma.user.findUnique).not.toHaveBeenCalled();
      expect(mockIsAdmin).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(401);
      expect(responseBody).toEqual({
        error: "Unauthorized",
        errorCode: "SESSION_EXPIRED",
        isKnownError: true,
      });
    });
  });

  describe("withEmailAccount", () => {
    const mockUserId = "user-123";
    const mockAccountId = "acc-456";
    const mockEmail = "test@example.com";

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: mockUserId } } as any);
    });

    it("should call handler with email account info if header exists and account is valid", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/test", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount(mockUserId, mockEmail);

      const handler = vi.fn(async (_req: RequestWithAuthAndEmail, _ctx: any) =>
        NextResponse.json({ success: true }),
      );
      const wrappedHandler = withEmailAccount(handler);

      await wrappedHandler(mockReq, mockContext);

      expect(handler).toHaveBeenCalledWith(
        expect.objectContaining({
          auth: {
            userId: mockUserId,
            emailAccountId: mockAccountId,
            email: mockEmail,
          },
        }),
        mockContext,
      );
    });

    it("preserves NextRequest APIs when adding email account info", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/test?view=all", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
        cookie: "display=compact",
      });
      mockOwnedAccount(mockUserId, mockEmail);
      const handler = vi.fn(async (request: RequestWithEmailAccount) =>
        NextResponse.json({
          pathname: request.nextUrl.pathname,
          view: request.nextUrl.searchParams.get("view"),
          display: request.cookies.get("display")?.value,
        }),
      );

      const response = await withEmailAccount(handler)(mockReq, mockContext);

      await expect(response.json()).resolves.toEqual({
        pathname: "/api/test",
        view: "all",
        display: "compact",
      });
    });

    it("should return 403 if email account header is missing", async () => {
      const handler = createEmailAccountHandler();
      const wrappedHandler = withEmailAccount(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(auth).toHaveBeenCalledTimes(1);
      expect(mockPrismaEmailAccountFindUnique).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      expect(responseBody).toEqual({
        error: "Email account ID is required",
        isKnownError: true,
      });
    });

    it("should return 403 if email account ID is invalid", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/test", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockPrismaEmailAccountFindUnique.mockResolvedValue(null);

      const handler = createEmailAccountHandler();
      const wrappedHandler = withEmailAccount(handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(auth).toHaveBeenCalledTimes(1);
      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      expect(responseBody).toEqual({
        error: "Invalid account ID",
        isKnownError: true,
      });
    });

    it("refuses another user's account with the same 403 as a missing one", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/test", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount("someone-else", mockEmail);
      const handler = createEmailAccountHandler();

      const response = await withEmailAccount(handler)(mockReq, mockContext);

      expect(handler).not.toHaveBeenCalled();
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid account ID",
        isKnownError: true,
      });
    });

    it("answers a request without a session with the 401, whoever owns the account", async () => {
      mockAuth.mockResolvedValue(null as any);
      mockReq = createMockRequest("GET", "http://localhost/api/test", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      const handler = createEmailAccountHandler();

      for (const owner of [mockUserId, "someone-else"]) {
        mockOwnedAccount(owner, mockEmail);
        const response = await withEmailAccount(handler)(mockReq, mockContext);
        expect(response.status).toBe(401);
        await expect(response.json()).resolves.toEqual({
          error: "Unauthorized",
          errorCode: "SESSION_EXPIRED",
          isKnownError: true,
        });
      }

      // Nor does a failed account read turn a missing session into a 500.
      mockPrismaEmailAccountFindUnique.mockRejectedValue(new Error("db down"));
      const response = await withEmailAccount(handler)(mockReq, mockContext);
      expect(response.status).toBe(401);
      expect(handler).not.toHaveBeenCalled();
    });

    it("reads the account alongside the session, not after it", async () => {
      let resolveSession: (session: unknown) => void = () => undefined;
      mockAuth.mockReturnValue(
        new Promise((resolve) => {
          resolveSession = resolve;
        }) as any,
      );
      mockReq = createMockRequest("GET", "http://localhost/api/test", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount(mockUserId, mockEmail);
      const handler = createEmailAccountHandler();

      const response = withEmailAccount(handler)(mockReq, mockContext);
      await vi.waitFor(() =>
        expect(mockPrismaEmailAccountFindUnique).toHaveBeenCalled(),
      );
      resolveSession({ user: { id: mockUserId } });

      expect((await response).status).toBe(200);
      expect(handler).toHaveBeenCalledTimes(1);
    });

    describe("org admins", () => {
      const adminUserId = "admin-1";

      beforeEach(() => {
        mockAuth.mockResolvedValue({ user: { id: adminUserId } } as any);
        mockReq = createMockRequest("GET", "http://localhost/api/test", {
          [EMAIL_ACCOUNT_HEADER]: mockAccountId,
        });
        // The target account belongs to a member, not to the admin.
        mockOwnedAccount(mockUserId, mockEmail);
      });

      it("refuses a caller who is not an admin of the account's organization", async () => {
        prisma.emailAccount.findFirst.mockResolvedValue(null);
        const handler = createEmailAccountHandler();

        const response = await withEmailAccount(handler, {
          allowOrgAdmins: true,
        })(mockReq, mockContext);

        expect(handler).not.toHaveBeenCalled();
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Insufficient permissions",
          isKnownError: true,
        });
      });

      it("refuses an admin when the member has not allowed analytics access", async () => {
        prisma.emailAccount.findFirst.mockResolvedValue({
          id: "admin-account",
        } as any);
        prisma.member.findFirst.mockResolvedValue({
          allowOrgAdminAnalytics: false,
        } as any);
        const handler = createEmailAccountHandler();

        const response = await withEmailAccount(handler, {
          allowOrgAdmins: true,
        })(mockReq, mockContext);

        expect(handler).not.toHaveBeenCalled();
        expect(response.status).toBe(403);
        await expect(response.json()).resolves.toEqual({
          error: "Analytics access not permitted by this member",
          isKnownError: true,
        });
      });

      it("lets an admin in when the member has allowed analytics access", async () => {
        prisma.emailAccount.findFirst.mockResolvedValue({
          id: "admin-account",
        } as any);
        prisma.member.findFirst.mockResolvedValue({
          allowOrgAdminAnalytics: true,
        } as any);
        const handler = createEmailAccountHandler();

        const response = await withEmailAccount(handler, {
          allowOrgAdmins: true,
        })(mockReq, mockContext);

        expect(response.status).toBe(200);
        expect(handler).toHaveBeenCalledWith(
          expect.objectContaining({
            auth: {
              userId: adminUserId,
              emailAccountId: mockAccountId,
              email: mockEmail,
            },
          }),
          mockContext,
        );
      });

      it("does not let an admin into a member's account on a route without org admin access", async () => {
        prisma.emailAccount.findFirst.mockResolvedValue({
          id: "admin-account",
        } as any);
        prisma.member.findFirst.mockResolvedValue({
          allowOrgAdminAnalytics: true,
        } as any);
        const handler = createEmailAccountHandler();

        const response = await withEmailAccount(handler)(mockReq, mockContext);

        expect(handler).not.toHaveBeenCalled();
        expect(response.status).toBe(403);
      });
    });
  });

  describe("withEmailProvider", () => {
    const mockUserId = "user-123";
    const mockAccountId = "acc-456";
    const mockEmail = "test@example.com";

    beforeEach(() => {
      mockAuth.mockResolvedValue({ user: { id: mockUserId } } as any);
    });

    it("answers a Gmail response's bare 429 as a Gmail rate limit, but not an AI provider's", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/assistant", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount(mockUserId, mockEmail);
      mockCreateEmailProvider.mockResolvedValue({ name: "google" } as any);
      mockCheckCommonErrors.mockReturnValue(null);
      const respond = (error: unknown) =>
        withEmailProvider("assistant", vi.fn().mockRejectedValue(error))(
          mockReq,
          mockContext,
        );

      // The AI SDK gives up with this after its own retries.
      const aiRateLimit = Object.assign(new Error("Rate limit exceeded"), {
        name: "AI_RetryError",
        reason: "maxRetriesExceeded",
        lastError: { statusCode: 429, message: "Rate limit exceeded" },
      });
      expect((await respond(aiRateLimit)).status).toBe(500);
      expect(mockRecordRateLimitFromApiError).not.toHaveBeenCalled();

      // Gaxios puts the HTTP response on the error, or on its cause.
      const gmailThrottle = new Error("Batch request failed", {
        cause: Object.assign(new Error("Too many requests"), {
          response: { status: 429 },
        }),
      });
      const gmail = await respond(gmailThrottle);
      expect(gmail.status).toBe(429);
      expect(gmail.headers.get("Retry-After")).not.toBeNull();
    });

    it("preserves NextRequest APIs when adding an email provider", async () => {
      mockReq = createMockRequest(
        "GET",
        "http://localhost/api/labels?view=all",
        {
          [EMAIL_ACCOUNT_HEADER]: mockAccountId,
          cookie: "display=compact",
        },
      );
      mockOwnedAccount(mockUserId, mockEmail);
      const emailProvider = { name: "provider" };
      mockCreateEmailProvider.mockResolvedValue(emailProvider as any);
      const handler = vi.fn(async (request: RequestWithEmailProvider) =>
        NextResponse.json({
          pathname: request.nextUrl.pathname,
          view: request.nextUrl.searchParams.get("view"),
          display: request.cookies.get("display")?.value,
          hasEmailProvider: request.emailProvider === emailProvider,
        }),
      );

      const response = await withEmailProvider(handler)(mockReq, mockContext);

      await expect(response.json()).resolves.toEqual({
        pathname: "/api/labels",
        view: "all",
        display: "compact",
        hasEmailProvider: true,
      });
    });

    it("checks the account and finds its provider in one read", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/labels", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount(mockUserId, mockEmail, "microsoft");
      mockCreateEmailProvider.mockResolvedValue({ name: "microsoft" } as any);
      const handler = vi.fn(async () => NextResponse.json({ ok: true }));

      const response = await withEmailProvider(handler)(mockReq, mockContext);

      expect(response.status).toBe(200);
      expect(mockPrismaEmailAccountFindUnique).toHaveBeenCalledTimes(1);
      expect(mockPrismaEmailAccountFindUnique).toHaveBeenCalledWith({
        where: { id: mockAccountId },
        select: {
          userId: true,
          email: true,
          account: { select: { provider: true } },
        },
      });
      expect(mockCreateEmailProvider).toHaveBeenCalledWith(
        expect.objectContaining({
          emailAccountId: mockAccountId,
          provider: "microsoft",
        }),
      );
    });

    it("refuses another user's account before creating a provider for it", async () => {
      mockReq = createMockRequest("GET", "http://localhost/api/labels", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount("someone-else", mockEmail);
      const handler = vi.fn(async () => NextResponse.json({ ok: true }));

      const response = await withEmailProvider(handler)(mockReq, mockContext);

      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: "Invalid account ID",
        isKnownError: true,
      });
      expect(mockCreateEmailProvider).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it("answers a request without a session with the 401", async () => {
      mockAuth.mockResolvedValue(null as any);
      mockReq = createMockRequest("GET", "http://localhost/api/labels", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount(mockUserId, mockEmail);
      const handler = vi.fn(async () => NextResponse.json({ ok: true }));

      const response = await withEmailProvider(handler)(mockReq, mockContext);

      expect(response.status).toBe(401);
      expect(mockCreateEmailProvider).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
    });

    it.each([
      [
        "Gmail",
        "google",
        {
          type: "Gmail Rate Limit Exceeded",
          message: "Gmail error: retry later",
          code: 429,
        },
      ],
      [
        "Outlook",
        "microsoft",
        {
          type: "Outlook Rate Limit",
          message: "Microsoft is temporarily limiting requests.",
          code: 429,
        },
      ],
    ] as const)("should return 429 for %s rate-limit mode errors from provider initialization", async (_caseName, provider, commonError) => {
      mockReq = createMockRequest("GET", "http://localhost/api/labels", {
        [EMAIL_ACCOUNT_HEADER]: mockAccountId,
      });
      mockOwnedAccount(mockUserId, mockEmail, provider);

      const rateLimitError = new Error("Rate-limit mode active");
      mockCreateEmailProvider.mockRejectedValue(rateLimitError);
      mockIsProviderRateLimitModeError.mockImplementation(
        (error) => error === rateLimitError,
      );
      mockCheckCommonErrors.mockReturnValue(commonError);

      const handler = vi.fn(async () => NextResponse.json({ ok: true }));
      const wrappedHandler = withEmailProvider("labels", handler);

      const response = await wrappedHandler(mockReq, mockContext);
      const responseBody = await response.json();

      expect(handler).not.toHaveBeenCalled();
      expect(checkCommonErrors).toHaveBeenCalledWith(
        rateLimitError,
        "/api/labels",
        expect.anything(),
      );
      expect(mockRecordRateLimitFromApiError).toHaveBeenCalledWith(
        expect.objectContaining({
          apiErrorType: commonError.type,
          error: rateLimitError,
          emailAccountId: mockAccountId,
          source: "labels",
        }),
      );
      expect(response.status).toBe(429);
      expect(responseBody).toEqual({
        error: commonError.message,
        isKnownError: true,
      });
    });
  });
});

function createMockRequest(
  method = "GET",
  url = "http://localhost/test",
  headers?: Record<string, string>,
): NextRequest {
  const request = new NextRequest(url, {
    method,
    headers: new Headers(headers),
  });
  return request;
}

function mockOwnedAccount(userId: string, email: string, provider = "google") {
  vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
    userId,
    email,
    account: { provider },
  } as any);
}

function createEmailAccountHandler() {
  return vi.fn(
    async (
      _req: RequestWithAuthAndEmail,
      _ctx: { params: Promise<Record<string, string>> },
    ): Promise<NextResponse> => NextResponse.json({}),
  );
}

describe("getUnauthorizedReason", () => {
  const base = { session: null, cookieNames: [], hasAuthorization: false };

  it("tells apart the ways a request ends up without a session", () => {
    expect(getUnauthorizedReason(base)).toBe("no_cookies");
    expect(getUnauthorizedReason({ ...base, hasAuthorization: true })).toBe(
      "authorization_header_without_cookie",
    );
    expect(
      getUnauthorizedReason({ ...base, cookieNames: ["theme", "ph_session"] }),
    ).toBe("no_session_cookie");
    expect(
      getUnauthorizedReason({
        ...base,
        cookieNames: ["__Secure-better-auth.session_token"],
      }),
    ).toBe("session_cookie_unresolved");
    expect(getUnauthorizedReason({ ...base, session: {} })).toBe(
      "session_without_user",
    );
  });
});
