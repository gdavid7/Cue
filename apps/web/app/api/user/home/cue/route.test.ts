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
    vi.mocked(hasCueReadMail).mockImplementation(
      async (emailAccountId) => emailAccountId === "read",
    );
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

  it.each([
    ["no account", ""],
    ["only separators", "?ids=,,"],
    [
      "more accounts than All inboxes holds",
      `?ids=${Array.from({ length: 21 }, (_, index) => `a${index}`).join(",")}`,
    ],
  ])("refuses a request that names %s", async (_case, search) => {
    const response = await getCue(search);

    expect(response.status).toBe(400);
    expect(prisma.emailAccount.findMany).not.toHaveBeenCalled();
  });

  it("takes ids given as separate parameters too", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([] as never);

    const response = await getCue("?ids=read&ids=new,read");

    expect(response.status).toBe(200);
    expect(prisma.emailAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: { in: ["read", "new"] }, userId: "user-1" },
      }),
    );
  });

  it("leaves out, as unknown, an account whose reads failed", async () => {
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "read" },
      { id: "broken" },
    ] as never);
    vi.mocked(hasCueReadMail).mockImplementation(async (id) => {
      if (id === "broken") throw new Error("Database unavailable");
      return true;
    });

    const response = await getCue("?ids=read,broken");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      accounts: [{ id: "read", hasReadMail: true }],
    });
  });
});

function getCue(search: string) {
  return GET(
    new NextRequest(`http://localhost:3000/api/user/home/cue${search}`),
    { params: Promise.resolve({}) },
  );
}
