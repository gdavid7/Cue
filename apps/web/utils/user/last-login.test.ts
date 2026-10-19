import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { recordLastLogin } from "@/utils/user/last-login";

vi.mock("@/utils/prisma");

describe("recordLastLogin", () => {
  it("writes only when the last login is unknown or over an hour old", async () => {
    const now = new Date("2026-10-19T12:00:00Z");

    await recordLastLogin("user@example.com", now);

    expect(prisma.user.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: {
        email: "user@example.com",
        OR: [
          { lastLogin: null },
          { lastLogin: { lt: new Date("2026-10-19T11:00:00Z") } },
        ],
      },
      data: { lastLogin: now },
    });
  });
});
