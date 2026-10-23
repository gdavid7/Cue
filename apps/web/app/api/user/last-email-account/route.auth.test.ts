import { NextRequest } from "next/server";
import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { LAST_EMAIL_ACCOUNT_COOKIE } from "@/utils/cookies";
import { POST } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn(async () => null) }));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));

describe("POST /api/user/last-email-account without a session", () => {
  it("is rejected and sets no cookie", async () => {
    const response = await POST(
      new NextRequest("http://localhost:3000/api/user/last-email-account", {
        method: "POST",
        body: JSON.stringify({ emailAccountId: "account-1" }),
      }),
      {},
    );

    expect(response.status).toBe(401);
    expect(prisma.emailAccount.findFirst).not.toHaveBeenCalled();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.cookies.get(LAST_EMAIL_ACCOUNT_COOKIE)).toBeUndefined();
  });
});
