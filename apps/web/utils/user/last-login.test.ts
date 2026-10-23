import { describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { recordLastLogin } from "@/utils/user/last-login";

vi.mock("@/utils/prisma");

describe("recordLastLogin", () => {
  it("writes only when the last login is unknown or over an hour old, and keeps the last visit after a break", async () => {
    const now = new Date("2026-10-19T12:00:00Z");

    await recordLastLogin("user-1", now);

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const [sql] = vi.mocked(prisma.$executeRaw).mock.calls[0] as unknown as [
      { sql: string; values: unknown[] },
    ];
    expect(sql.sql).toContain('"previousVisitAt" = CASE');
    expect(sql.values).toEqual([
      // A break: four hours without a write.
      new Date("2026-10-19T08:00:00Z"),
      now,
      "user-1",
      new Date("2026-10-19T11:00:00Z"),
    ]);
  });
});
