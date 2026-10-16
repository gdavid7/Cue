import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordActiveDay } from "@/utils/analytics/activation";

const { afterCallbacks } = vi.hoisted(() => ({
  afterCallbacks: [] as Array<() => unknown>,
}));

vi.mock("next/server", async (importActual) => ({
  ...(await importActual<typeof import("next/server")>()),
  after: (callback: () => unknown) => afterCallbacks.push(callback),
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailAccountTestMiddleware();
});
vi.mock("@/utils/split-inbox/settings.server", () => ({
  getMailSettings: vi.fn(async () => ({
    layout: null,
    expandedPreview: false,
    splits: [],
    replyTracking: true,
  })),
}));
vi.mock("@/utils/analytics/activation", () => ({
  recordActiveDay: vi.fn(),
}));

import { GET } from "./route";

describe("GET /api/mail/settings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    afterCallbacks.length = 0;
  });

  it("counts opening Mail as an active day once the response is sent", async () => {
    const response = await GET(
      new NextRequest("http://localhost:3000/api/mail/settings"),
      { params: Promise.resolve({}) },
    );

    expect(response.status).toBe(200);
    expect(recordActiveDay).not.toHaveBeenCalled();
    for (const callback of afterCallbacks) await callback();
    expect(recordActiveDay).toHaveBeenCalledWith("email-account-1");
  });
});
