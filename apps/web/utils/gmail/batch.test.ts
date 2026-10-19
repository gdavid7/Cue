import { afterEach, describe, expect, it, vi } from "vitest";
import {
  rememberGmailAccessToken,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import {
  GMAIL_INFLIGHT_LIMIT,
  resetGmailInflightState,
} from "@/utils/gmail/inflight";
import { getBatch } from "./batch";

vi.mock("@/utils/gmail/oauth", () => ({
  getGoogleGmailBatchUrl: () => "https://example.com/batch/gmail/v1",
}));
vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
}));

describe("getBatch", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("cuts the account's budget when Gmail refuses an item in the batch for volume", async () => {
    rememberGmailAccessToken("batch-token", "account-batch");
    const cutBudget = vi.spyOn(gmailQuotaStore, "cutBudget");
    const refusal = JSON.stringify({
      error: {
        code: 403,
        message:
          "Quota exceeded for quota metric 'Queries' and limit 'Units per minute per user'",
        errors: [{ reason: "rateLimitExceeded" }],
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `--response_boundary\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"m1"}\r\n--response_boundary\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\n\r\n${refusal}\r\n--response_boundary--`,
          {
            headers: {
              "Content-Type": "multipart/mixed; boundary=response_boundary",
            },
          },
        ),
      ),
    );

    await getBatch(["m1", "m2"], "/gmail/v1/users/me/messages", "batch-token");

    expect(cutBudget).toHaveBeenCalledTimes(1);
    // Only 40 units went through in the last minute, so the floor holds.
    await expect(cutBudget.mock.results[0]?.value).resolves.toBe(1200);
  });

  it("holds one in-flight slot per request in the batch", async () => {
    resetGmailInflightState();
    rememberGmailAccessToken("inflight-token", "account-batch-inflight");
    let subrequests = 0;
    let maxSubrequests = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const count = init.body.split("GET ").length - 1;
        subrequests += count;
        maxSubrequests = Math.max(maxSubrequests, subrequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        subrequests -= count;
        return new Response(
          `--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"m"}\r\n--b--`,
          { headers: { "Content-Type": "multipart/mixed; boundary=b" } },
        );
      }),
    );

    await runWithGmailQuota({ caller: "test/sync", priority: "sync" }, () =>
      Promise.all(
        Array.from({ length: 6 }, (_, index) =>
          getBatch(
            [`a${index}`, `b${index}`, `c${index}`],
            "/gmail/v1/users/me/labels",
            "inflight-token",
          ),
        ),
      ),
    );

    // Two batches of three fit under the sync share; a third would not.
    expect(maxSubrequests).toBeLessThanOrEqual(GMAIL_INFLIGHT_LIMIT);
    expect(maxSubrequests).toBe(6);
  });

  it("splits a large set into batches that fit the in-flight cap, in order", async () => {
    resetGmailInflightState();
    rememberGmailAccessToken("split-token", "account-batch-split");
    let subrequests = 0;
    let maxSubrequests = 0;
    let largestBatch = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        const ids = [...init.body.matchAll(/GET \S+\/labels\/(\S+)/g)].map(
          (match) => match[1],
        );
        subrequests += ids.length;
        largestBatch = Math.max(largestBatch, ids.length);
        maxSubrequests = Math.max(maxSubrequests, subrequests);
        await new Promise((resolve) => setTimeout(resolve, 5));
        subrequests -= ids.length;
        return new Response(
          `${ids
            .map(
              (id) =>
                `--b\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"${id}"}\r\n`,
            )
            .join("")}--b--`,
          { headers: { "Content-Type": "multipart/mixed; boundary=b" } },
        );
      }),
    );
    const ids = Array.from({ length: 50 }, (_, index) => `label-${index}`);

    const items = await runWithGmailQuota(
      { caller: "test/sync", priority: "sync" },
      () => getBatch(ids, "/gmail/v1/users/me/labels", "split-token"),
    );

    expect(items.map((item: { id: string }) => item.id)).toEqual(ids);
    expect(largestBatch).toBe(6);
    expect(maxSubrequests).toBe(6);
  });

  it("prevents message IDs from injecting multipart subrequests", async () => {
    const validId = "18f4c6b280d6f124";
    const injectedId =
      "message-id\r\n\r\n--batch_boundary\r\nContent-Type: application/http\r\n\r\nGET /gmail/v1/users/me/messages/injected";
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        '--response_boundary\r\nContent-Type: application/http\r\n\r\nHTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"id":"18f4c6b280d6f124"}\r\n--response_boundary--',
        {
          headers: {
            "Content-Type": "multipart/mixed; boundary=response_boundary",
          },
        },
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await getBatch(
      [validId, injectedId],
      "/gmail/v1/users/me/messages",
      "access-token",
    );

    const requestBody = fetchMock.mock.calls[0]?.[1]?.body as string;

    expect(requestBody).toContain(
      `GET /gmail/v1/users/me/messages/${validId}\n\n`,
    );
    expect(requestBody).toContain(
      `GET /gmail/v1/users/me/messages/${encodeURIComponent(injectedId)}\n\n`,
    );
    expect(requestBody.match(/^GET /gm)).toHaveLength(2);
    expect(requestBody).not.toContain(
      "\r\nGET /gmail/v1/users/me/messages/injected",
    );
  });
});
