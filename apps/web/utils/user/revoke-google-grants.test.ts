import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { revokeGoogleGrants } from "@/utils/user/revoke-google-grants";

vi.mock("@/utils/prisma");

const logger = createTestLogger();
const fetchMock = vi.fn();

describe("revokeGoogleGrants", () => {
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
    ] as unknown as Awaited<ReturnType<typeof prisma.account.findMany>>);
    prisma.calendarConnection.count.mockResolvedValue(0);
    prisma.driveConnection.count.mockResolvedValue(0);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("revokes the removed mailbox's refresh token at Google", async () => {
    await revokeGoogleGrants({
      emailAccountIds: ["email-account-1"],
      keepsConnections: false,
      logger,
    });

    expect(prisma.account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          provider: "google",
          disconnectedAt: null,
          emailAccount: { id: { in: ["email-account-1"] } },
        },
      }),
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://oauth2.googleapis.com/revoke");
    expect(init.method).toBe("POST");
    expect(new URLSearchParams(init.body).get("token")).toBe("refresh-token-1");
  });

  it("keeps the grant when a connection on another mailbox uses the same Google account", async () => {
    prisma.driveConnection.count.mockResolvedValue(1);

    await revokeGoogleGrants({
      emailAccountIds: ["email-account-1"],
      keepsConnections: false,
      logger,
    });

    expect(prisma.driveConnection.count).toHaveBeenCalledWith({
      where: {
        provider: "google",
        isConnected: true,
        email: { equals: "owner@example.com", mode: "insensitive" },
        emailAccountId: { notIn: ["email-account-1"] },
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("counts the removed mailbox's own connections when they move to a remaining mailbox", async () => {
    prisma.calendarConnection.count.mockResolvedValue(1);

    await revokeGoogleGrants({
      emailAccountIds: ["email-account-1"],
      keepsConnections: true,
      logger,
    });

    expect(prisma.calendarConnection.count).toHaveBeenCalledWith({
      where: expect.objectContaining({ emailAccountId: { notIn: [] } }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw when Google rejects or is unreachable", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    await expect(
      revokeGoogleGrants({
        emailAccountIds: ["email-account-1"],
        keepsConnections: false,
        logger,
      }),
    ).resolves.toBeUndefined();

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 400 }));
    await expect(
      revokeGoogleGrants({
        emailAccountIds: ["email-account-1"],
        keepsConnections: false,
        logger,
      }),
    ).resolves.toBeUndefined();

    prisma.account.findMany.mockRejectedValueOnce(new Error("db down"));
    await expect(
      revokeGoogleGrants({
        emailAccountIds: ["email-account-1"],
        keepsConnections: false,
        logger,
      }),
    ).resolves.toBeUndefined();
  });
});
