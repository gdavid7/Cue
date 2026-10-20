import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  getGoogleGrants,
  revokeGoogleGrants,
} from "@/utils/user/revoke-google-grants";

vi.mock("@/utils/prisma");

const logger = createTestLogger();
const fetchMock = vi.fn();

describe("Google grant revocation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    prisma.account.findMany.mockResolvedValue([
      {
        id: "account-1",
        refresh_token: "refresh-token-1",
        access_token: "access-token-1",
        emailAccount: { id: "email-account-1", email: "owner@example.com" },
      },
      {
        id: "login-only-account",
        refresh_token: null,
        access_token: "access-token-2",
        emailAccount: null,
      },
    ] as unknown as Awaited<ReturnType<typeof prisma.account.findMany>>);
    prisma.calendarConnection.count.mockResolvedValue(0);
    prisma.driveConnection.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revokes each account's refresh token, falling back to its access token", async () => {
    const grants = await getGoogleGrants({ where: { userId: "u" }, logger });
    await revokeGoogleGrants({ grants, logger });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const revoked = fetchMock.mock.calls.map(([url, init]) => {
      expect(url).toBe("https://oauth2.googleapis.com/revoke");
      return new URLSearchParams(init.body).get("token");
    });
    expect(revoked.sort()).toEqual(["access-token-2", "refresh-token-1"]);
  });

  it("keeps the grant while a stored connection uses the same Google account", async () => {
    prisma.driveConnection.count.mockResolvedValue(1);
    prisma.account.findMany.mockResolvedValue([
      {
        id: "account-1",
        refresh_token: "refresh-token-1",
        access_token: null,
        emailAccount: { id: "email-account-1", email: "owner@example.com" },
      },
    ] as unknown as Awaited<ReturnType<typeof prisma.account.findMany>>);

    const grants = await getGoogleGrants({ where: { userId: "u" }, logger });
    await revokeGoogleGrants({ grants, logger });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws when the read, the check or Google fails", async () => {
    prisma.account.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      getGoogleGrants({ where: { userId: "u" }, logger }),
    ).resolves.toEqual([]);

    const grants = await getGoogleGrants({ where: { userId: "u" }, logger });

    fetchMock.mockRejectedValueOnce(new Error("network down"));
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      revokeGoogleGrants({ grants, logger }),
    ).resolves.toBeUndefined();

    prisma.calendarConnection.count.mockRejectedValueOnce(new Error("db down"));
    await expect(
      revokeGoogleGrants({ grants, logger }),
    ).resolves.toBeUndefined();
  });
});
