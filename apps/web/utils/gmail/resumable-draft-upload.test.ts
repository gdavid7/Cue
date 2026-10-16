import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createGmailQuotaStats,
  meterGmailCall,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
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
