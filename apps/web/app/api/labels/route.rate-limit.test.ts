import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { GmailProvider } from "@/utils/email/google";
import { createEmailProvider } from "@/utils/email/provider";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import { createScopedLogger } from "@/utils/logger";
import { getEmailAccount } from "@/utils/redis/account-validation";
import { GET, maxDuration } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/redis/account-validation");
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/error.server");
vi.mock("@/utils/auth/save-tokens", () => ({ saveTokens: vi.fn() }));
vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
  getEmailProviderRateLimitStateFromRedis: vi.fn().mockResolvedValue(null),
  setEmailProviderRateLimitStateInRedis: vi.fn().mockResolvedValue(undefined),
  deleteEmailProviderRateLimitStateFromRedis: vi
    .fn()
    .mockResolvedValue(undefined),
}));

const EMAIL_ACCOUNT_ID = "account-labels-rate-limit";
// Google's per-user minute quota, as production saw it on /api/labels.
const PER_MINUTE_REFUSAL = {
  error: {
    code: 403,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user' of service 'gmail.googleapis.com'",
    errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }],
  },
};

describe("GET /api/labels under a Gmail rate limit", () => {
  beforeEach(() => {
    (gmailQuotaStore as unknown as { reset(): void }).reset();
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      session: {},
    } as Awaited<ReturnType<typeof auth>>);
    vi.mocked(getEmailAccount).mockResolvedValue("user@example.com");
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: EMAIL_ACCOUNT_ID,
      account: { provider: "google" },
    } as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("answers well inside maxDuration with a retryable status instead of timing out", async () => {
    const gmail = await fakeGmailRefusingEveryCall();
    vi.mocked(createEmailProvider).mockResolvedValue(
      new GmailProvider(gmail.client, undefined, EMAIL_ACCOUNT_ID),
    );
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const startedAt = Date.now();

    let settled = false;
    const pending = GET(request(), context()).finally(() => {
      settled = true;
    });
    while (!settled && Date.now() - startedAt < 120_000) {
      await vi.advanceTimersByTimeAsync(250);
    }
    const response = await pending;
    const elapsedMs = Date.now() - startedAt;

    expect(gmail.gmailRequests()).toBeGreaterThan(0);
    expect(elapsedMs).toBeLessThanOrEqual(maxDuration * 1000 - 10_000);
    // Gmail's own refusal, given up on before the deadline: a rate limit.
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });
});

async function fakeGmailRefusingEveryCall() {
  const requests: string[] = [];
  const fetchImpl = async (input: unknown) => {
    const url = String(input instanceof URL ? input.href : input);
    requests.push(url);
    return new Response(JSON.stringify(PER_MINUTE_REFUSAL), {
      status: 403,
      headers: { "content-type": "application/json" },
    });
  };
  const client = await getGmailClientWithRefresh({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    emailAccountId: EMAIL_ACCOUNT_ID,
    logger: createScopedLogger("labels-rate-limit-test"),
  });
  // googleapis has no public hook for its transport, so this reaches into
  // the auth client's transporter, as client-metering.test.ts does, to send
  // every call (the token refresh included) to the fake.
  const gmailAuth = client.context._options.auth as {
    transporter: { defaults: { fetchImplementation?: unknown } };
  };
  gmailAuth.transporter.defaults.fetchImplementation = fetchImpl;
  vi.stubGlobal("fetch", fetchImpl);
  return {
    client,
    gmailRequests: () =>
      requests.filter((url) => url.includes("/gmail/v1/")).length,
  };
}

function request() {
  return new NextRequest("http://localhost/api/labels", {
    headers: { [EMAIL_ACCOUNT_HEADER]: EMAIL_ACCOUNT_ID },
  });
}

function context() {
  return { params: Promise.resolve({}) };
}
