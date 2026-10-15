vi.mock("server-only", () => ({}));

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("@inboxzero/transactional-email/src/delivery", () => ({
  isTransactionalEmailConfigured: () => true,
}));
vi.mock("@/utils/middleware", () => ({
  withAuth:
    (
      _scope: string,
      handler: (request: NextRequest, ...args: unknown[]) => Promise<Response>,
    ) =>
    (request: NextRequest, ...args: unknown[]) =>
      handler(Object.assign(request, { auth: { userId: "user_1" } }), ...args),
}));

import { GET } from "./route";

describe("user/email-otp route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it.each([
    true,
    false,
  ])("reports codes as available only for a verified address (%s)", async (emailVerified) => {
    prisma.user.findUniqueOrThrow.mockResolvedValue({
      email: "owner@example.com",
      emailOtpEnabled: true,
      emailVerified,
    } as never);

    const response = await GET(
      new NextRequest("http://localhost:3000/api/user/email-otp"),
      {} as never,
    );

    expect(await response.json()).toMatchObject({
      emailOtpEnabled: true,
      canEnable: emailVerified,
    });
  });
});
