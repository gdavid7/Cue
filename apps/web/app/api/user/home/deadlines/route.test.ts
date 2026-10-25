import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/middleware", async () => {
  const { createWithEmailAccountTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithEmailAccountTestMiddleware();
});
vi.mock("@/utils/home/next-up", () => ({
  getDeadlines: vi.fn(),
}));

import { getDeadlines } from "@/utils/home/next-up";
import { GET } from "./route";

const DEADLINE = {
  id: "canvas-4",
  kind: "deadline" as const,
  title: "Problem set 4",
  at: "2026-10-13T20:00:00.000Z",
  source: "Canvas",
};

describe("GET /api/user/home/deadlines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getDeadlines).mockResolvedValue({ items: [DEADLINE] });
  });

  it("answers with the signed-in account's deadlines, in the browser's day", async () => {
    const response = await getDeadlinesRoute("?tz=America%2FLos_Angeles");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [DEADLINE] });
    expect(getDeadlines).toHaveBeenCalledWith(
      expect.objectContaining({
        emailAccountId: "email-account-1",
        timeZone: "America/Los_Angeles",
      }),
    );
  });

  it("counts the day in UTC when the browser's zone is missing or unknown", async () => {
    await getDeadlinesRoute("?tz=Nowhere%2FElse");
    await getDeadlinesRoute("");

    expect(
      vi.mocked(getDeadlines).mock.calls.map(([args]) => args.timeZone),
    ).toEqual(["UTC", "UTC"]);
  });

  it("keeps the user's tasks out of shared caches", async () => {
    const response = await getDeadlinesRoute("");

    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });
});

function getDeadlinesRoute(search: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/user/home/deadlines${search}`),
    { params: Promise.resolve({}) },
  );
}
