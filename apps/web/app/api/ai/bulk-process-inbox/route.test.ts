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
vi.mock("@/utils/qstash", () => ({
  withQstashOrInternal: (handler: unknown) => handler,
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

  it("resumes the deferred sort with its deferral count", async () => {
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
});

function resume() {
  return new Request("http://localhost/api/ai/bulk-process-inbox", {
    method: "POST",
    body: JSON.stringify({
      emailAccountId: "account-1",
      provider: "google",
      maxEmails: 20,
      skipArchive: true,
      deferrals: 2,
    }),
  }) as never;
}
