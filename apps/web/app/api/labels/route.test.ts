import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { GET } from "./route";

const { getLabels } = vi.hoisted(() => ({ getLabels: vi.fn() }));

vi.mock("@/utils/middleware", async () => {
  const { createWithEmailProviderTestMiddleware } = await import(
    "@/__tests__/helpers"
  );
  return createWithEmailProviderTestMiddleware({ getLabels });
});

describe("GET /api/labels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("lets a quota deferral reach the middleware instead of answering 500", async () => {
    // The middleware turns a deferral into a 503 with Retry-After.
    const deferred = new GmailCallDeferredError(15_000, "sync");
    getLabels.mockRejectedValue(deferred);

    await expect(GET(request(), context())).rejects.toBe(deferred);
  });

  it("returns the account's labels", async () => {
    getLabels.mockResolvedValue([
      { id: "Label_1", name: "Receipts", type: "user" },
    ]);

    const response = await GET(request(), context());

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      labels: [{ id: "Label_1", name: "Receipts", type: "user" }],
    });
  });
});

function request() {
  return new NextRequest("http://localhost/api/labels");
}

function context() {
  return { params: Promise.resolve({}) };
}
