import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { LAST_EMAIL_ACCOUNT_COOKIE } from "@/utils/cookies";

vi.mock("@/utils/prisma");
vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithAuthTestMiddleware({ userId: "user-1" });
});

import { POST } from "./route";

describe("POST /api/user/last-email-account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findFirst.mockResolvedValue({
      id: "account-1",
    } as Awaited<ReturnType<typeof prisma.emailAccount.findFirst>>);
  });

  it("sets the httpOnly last-account cookie for an owned account", async () => {
    const response = await POST(post({ emailAccountId: "account-1" }), {});

    expect(response.status).toBe(200);
    expect(prisma.emailAccount.findFirst).toHaveBeenCalledWith({
      where: { id: "account-1", userId: "user-1" },
      select: { id: true },
    });
    const cookie = response.cookies.get(LAST_EMAIL_ACCOUNT_COOKIE);
    expect(JSON.parse(cookie?.value ?? "")).toEqual({
      userId: "user-1",
      emailAccountId: "account-1",
    });
    expect(cookie).toMatchObject({
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
      sameSite: "lax",
      httpOnly: true,
      secure: false,
    });
  });

  it("does not set the cookie for an account the user does not own", async () => {
    prisma.emailAccount.findFirst.mockResolvedValue(null);

    const response = await POST(post({ emailAccountId: "other" }), {});

    expect(response.status).toBe(404);
    expect(response.cookies.get(LAST_EMAIL_ACCOUNT_COOKIE)).toBeUndefined();
  });

  it("rejects a missing account id", async () => {
    const response = await POST(post({}), {});

    expect(response.status).toBe(400);
    expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
  });
});

function post(body: unknown) {
  return new NextRequest("http://localhost:3000/api/user/last-email-account", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
