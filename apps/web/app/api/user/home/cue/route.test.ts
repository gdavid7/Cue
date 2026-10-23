import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");
  return createWithAuthTestMiddleware();
});
vi.mock("@/utils/home/get-home", () => ({
  hasCueReadMail: vi.fn(
    async (emailAccountId: string) => emailAccountId === "read",
  ),
}));

import { hasCueReadMail } from "@/utils/home/get-home";
import { GET } from "./route";

describe("GET /api/user/home/cue", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("answers for each of the user's own accounts asked for, and no other", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "read" },
      { id: "new" },
    ] as never);

    const response = await getCue("?ids=read,new,someone-else,new");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [
        { id: "read", hasReadMail: true },
        { id: "new", hasReadMail: false },
      ],
    });
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ["read", "new", "someone-else"] },
          userId: "user-1",
        },
      }),
    );
    expect(vi.mocked(hasCueReadMail).mock.calls.map(([id]) => id)).toEqual([
      "read",
      "new",
    ]);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
  });

  it("refuses a request that names no account", async () => {
    const response = await getCue("");

    expect(response.status).toBe(400);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });
});

function getCue(search: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/user/home/cue${search}`),
    { params: Promise.resolve({}) },
  );
}
