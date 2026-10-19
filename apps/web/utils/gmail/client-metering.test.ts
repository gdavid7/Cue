import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { auth as gmailAuth } from "@googleapis/gmail";
import { createScopedLogger } from "@/utils/logger";
import { getGmailClientWithRefresh } from "@/utils/gmail/client";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import { createGmailQuotaStats, runWithGmailQuota } from "@/utils/gmail/quota";
import {
  GMAIL_INFLIGHT_LIMIT,
  resetGmailInflightState,
} from "@/utils/gmail/inflight";

vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
}));
vi.mock("@/utils/auth/save-tokens", () => ({ saveTokens: vi.fn() }));

const logger = createScopedLogger("gmail-client-metering-test");
const MESSAGE_GET_UNITS = 20;
const QUOTA_REFUSAL = {
  error: {
    code: 403,
    message:
      "Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'",
    errors: [{ reason: "rateLimitExceeded", domain: "usageLimits" }],
  },
};

// Every request Gmail receives is charged by Gmail, so the gate has to charge
// it too, or Google's count runs ahead of the account's budget.
describe("Gmail client metering", () => {
  beforeEach(() => {
    (gmailQuotaStore as unknown as { reset(): void }).reset();
    resetGmailInflightState();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("sends a call Gmail refuses for quota once, without refreshing the token", async () => {
    const gmail = await fakeGmail([jsonResponse(403, QUOTA_REFUSAL)]);
    const stats = createGmailQuotaStats();

    await expect(
      runWithGmailQuota(
        { caller: "test", priority: "interactive", stats },
        () => gmail.client.users.messages.get({ userId: "me", id: "m1" }),
      ),
    ).rejects.toMatchObject({ status: 403 });

    expect(gmail.tokenRequests()).toBe(0);
    expect(gmail.gmailRequests()).toBe(1);
    expect(stats.admittedCost).toBe(MESSAGE_GET_UNITS);
  });

  it("refreshes a rejected token and charges the resent call", async () => {
    const gmail = await fakeGmail([
      jsonResponse(401, {
        error: { code: 401, message: "Invalid Credentials" },
      }),
      jsonResponse(200, { id: "m1" }),
    ]);
    const stats = createGmailQuotaStats();

    const response = await runWithGmailQuota(
      { caller: "test", priority: "interactive", stats },
      () => gmail.client.users.messages.get({ userId: "me", id: "m1" }),
    );

    expect(response.data.id).toBe("m1");
    expect(gmail.tokenRequests()).toBe(1);
    expect(gmail.gmailRequests()).toBe(2);
    expect(stats.admittedCost).toBe(2 * MESSAGE_GET_UNITS);
  });

  it("charges each attempt the client retries after a server error", async () => {
    const gmail = await fakeGmail([
      jsonResponse(503, { error: { code: 503, message: "Backend Error" } }),
      jsonResponse(200, { id: "m1" }),
    ]);
    const stats = createGmailQuotaStats();

    const response = await runWithGmailQuota(
      { caller: "test", priority: "interactive", stats },
      () => gmail.client.users.messages.get({ userId: "me", id: "m1" }),
    );

    expect(response.data.id).toBe("m1");
    expect(gmail.gmailRequests()).toBe(2);
    expect(stats.admittedCost).toBe(2 * MESSAGE_GET_UNITS);
  });

  it("keeps no more of the account's calls in flight than the cap", async () => {
    let inflight = 0;
    let maxInflight = 0;
    const calls = 3 * GMAIL_INFLIGHT_LIMIT;
    const slowLabels = () => async () => {
      inflight += 1;
      maxInflight = Math.max(maxInflight, inflight);
      await new Promise((resolve) => setTimeout(resolve, 5));
      inflight -= 1;
      return jsonResponse(200, { labels: [] })();
    };
    const gmail = await fakeGmail(Array.from({ length: calls }, slowLabels));

    await runWithGmailQuota({ caller: "test", priority: "interactive" }, () =>
      Promise.all(
        Array.from({ length: calls }, () =>
          gmail.client.users.labels.list({ userId: "me" }),
        ),
      ),
    );

    expect(gmail.gmailRequests()).toBe(calls);
    expect(maxInflight).toBe(GMAIL_INFLIGHT_LIMIT);
  });
});

/** A Gmail client whose requests answer from `responses` in order. */
async function fakeGmail(responses: Array<() => Response | Promise<Response>>) {
  const requests: string[] = [];
  const fetchImpl = async (input: unknown) => {
    const url = String(input instanceof URL ? input.href : input);
    requests.push(url);
    if (url.includes("/token"))
      return jsonResponse(200, {
        access_token: "fresh-token",
        expires_in: 3600,
        token_type: "Bearer",
      })();
    const next = responses.shift();
    if (!next) throw new Error(`Unexpected Gmail request ${url}`);
    return next();
  };
  const client = await getGmailClientWithRefresh({
    accessToken: "access-token",
    refreshToken: "refresh-token",
    expiresAt: Date.now() + 3_600_000,
    emailAccountId: "account-metering",
    logger,
  });
  const auth = client.context._options.auth as InstanceType<
    typeof gmailAuth.OAuth2
  >;
  auth.transporter.defaults.fetchImplementation =
    fetchImpl as unknown as typeof fetch;
  vi.stubGlobal("fetch", fetchImpl);
  // Gaxios waits 100 ms before its first retry; keep the test fast.
  client.context._options.retryConfig = {
    ...client.context._options.retryConfig,
    retryDelay: 1,
  };
  return {
    client,
    tokenRequests: () =>
      requests.filter((url) => url.includes("/token")).length,
    gmailRequests: () =>
      requests.filter((url) => url.includes("/gmail/v1/")).length,
  };
}

function jsonResponse(status: number, body: unknown) {
  return () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
}
