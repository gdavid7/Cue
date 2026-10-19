import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGmailQuotaStats,
  meterGmailCall,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import { GMAIL_INFLIGHT_LIMIT } from "@/utils/gmail/inflight";
import { uploadGmailDraftChunk } from "@/utils/gmail/resumable-draft-upload";

vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
}));

const SESSION_URI =
  "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts/r-1?uploadType=resumable&upload_id=abc";

describe("Gmail traffic the quota gate must see", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("charges each draft upload chunk to the account, as Gmail does", async () => {
    const take = vi.spyOn(gmailQuotaStore, "take");
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(null, { status: 308, headers: { range: "bytes=0-3" } }),
      ),
    );
    const stats = createGmailQuotaStats();

    const result = await runWithGmailQuota(
      { caller: "draft-upload", priority: "interactive", stats },
      () =>
        uploadGmailDraftChunk({
          emailAccountId: "account-upload",
          accessToken: "upload-token",
          sessionUri: SESSION_URI,
          start: 0,
          bytes: new Uint8Array(4),
          totalBytes: 8,
        }),
    );

    expect(result).toEqual({ status: "incomplete", nextOffset: 4 });
    expect(stats.admittedCost).toBeGreaterThan(0);
    expect(take).toHaveBeenCalledWith(
      expect.objectContaining({
        bucketKey: "gmail-quota:account-upload:bucket",
      }),
    );
  });

  it("keeps no more of the account's upload chunks in flight than the cap", async () => {
    let inflight = 0;
    let maxInflight = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        inflight += 1;
        maxInflight = Math.max(maxInflight, inflight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inflight -= 1;
        return new Response(null, { status: 200 });
      }),
    );

    await runWithGmailQuota(
      { caller: "draft-upload", priority: "interactive" },
      () =>
        Promise.all(
          Array.from({ length: 2 * GMAIL_INFLIGHT_LIMIT }, (_, index) =>
            uploadGmailDraftChunk({
              emailAccountId: "account-upload-cap",
              accessToken: "upload-token",
              sessionUri: SESSION_URI,
              start: index,
              bytes: new Uint8Array(1),
              totalBytes: 2 * GMAIL_INFLIGHT_LIMIT,
            }),
          ),
        ),
    );

    expect(maxInflight).toBe(GMAIL_INFLIGHT_LIMIT);
  });

  it("reports a caller whose Gmail calls name no account, once", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    for (let call = 0; call < 2; call++)
      await runWithGmailQuota(
        { caller: "test/no-account", priority: "sync" },
        () =>
          meterGmailCall({ emailAccountId: undefined, cost: 5 }, async () =>
            Promise.resolve("ok"),
          ),
      );

    const reports = warn.mock.calls.filter(
      ([line]) =>
        String(line).includes("Gmail call admitted without an account") &&
        String(line).includes("test/no-account"),
    );
    expect(reports).toHaveLength(1);
  });
});
