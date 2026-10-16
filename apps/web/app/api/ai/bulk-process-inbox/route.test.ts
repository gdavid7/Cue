import { beforeEach, describe, expect, it, vi } from "vitest";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";
import { POST } from "./route";

vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithErrorTestMiddleware();
});
// Stands in for QStash signature or internal key verification.
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal:
    (handler: (...args: unknown[]) => unknown) =>
    (request: Request, ...rest: unknown[]) =>
      request.headers.get("x-test-verified")
        ? handler(request, ...rest)
        : new Response("Unauthorized", { status: 401 }),
}));
vi.mock("@/utils/ai/choose-rule/bulk-process-emails", () => ({
  bulkProcessInboxEmails: vi.fn(),
}));
vi.mock("@/utils/user/get", () => ({
  getEmailAccountForRuleExecution: vi.fn(),
}));

describe("bulk inbox processing resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes the deferred sort with its start time and deferral count", async () => {
    vi.mocked(getEmailAccountForRuleExecution).mockResolvedValue({
      id: "account-1",
    } as never);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(bulkProcessInboxEmails).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccount: { id: "account-1" },
        provider: "google",
        maxEmails: 20,
        skipArchive: true,
        startedAt: 1_700_000_000_000,
        deferrals: 2,
      }),
    );
  });

  it("does nothing once the account is gone", async () => {
    vi.mocked(getEmailAccountForRuleExecution).mockResolvedValue(null);

    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(bulkProcessInboxEmails).not.toHaveBeenCalled();
  });

  it("refuses a request that is neither signed nor internal", async () => {
    const response = await POST(resume({ verified: false }), {} as never);

    expect(response.status).toBe(401);
    expect(bulkProcessInboxEmails).not.toHaveBeenCalled();
  });
});

function resume({ verified = true } = {}) {
  return new Request("http://localhost/api/ai/bulk-process-inbox", {
    method: "POST",
    headers: verified ? { "x-test-verified": "1" } : {},
    body: JSON.stringify({
      emailAccountId: "account-1",
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      startedAt: 1_700_000_000_000,
      deferrals: 2,
    }),
  }) as never;
}
