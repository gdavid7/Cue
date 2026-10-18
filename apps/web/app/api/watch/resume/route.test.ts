import { beforeEach, describe, expect, it, vi } from "vitest";
import { ensureEmailAccountsWatched } from "@/utils/email/watch-manager";
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
vi.mock("@/utils/email/watch-manager", () => ({
  ensureEmailAccountsWatched: vi
    .fn()
    .mockResolvedValue({ results: [], left: 0 }),
}));

describe("deferred watch resume", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("watches only the deferred mailbox again, carrying its deferral count", async () => {
    const response = await POST(resume(), {} as never);

    expect(response.status).toBe(200);
    expect(ensureEmailAccountsWatched).toHaveBeenCalledWith(
      expect.objectContaining({
        userIds: null,
        emailAccountId: "account-1",
        deferrals: 2,
      }),
    );
  });

  it("refuses a request that is neither signed nor internal", async () => {
    const response = await POST(resume({ verified: false }), {} as never);

    expect(response.status).toBe(401);
    expect(ensureEmailAccountsWatched).not.toHaveBeenCalled();
  });
});

function resume({ verified = true } = {}) {
  return new Request("http://localhost/api/watch/resume", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(verified ? { "x-test-verified": "1" } : {}),
    },
    body: JSON.stringify({ emailAccountId: "account-1", deferrals: 2 }),
  });
}
