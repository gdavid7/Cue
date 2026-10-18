import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { disconnectDriveAction } from "@/utils/actions/drive";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

describe("disconnectDriveAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      account: { userId: "user-1", provider: "google" },
    } as any);
  });

  it("disconnects the drive from this mailbox, leaving another mailbox's own copy and its filing", async () => {
    prisma.driveConnection.findFirst.mockResolvedValue({
      provider: "google",
      email: "me@work.com",
    } as any);

    const result = await disconnectDriveAction("personal" as any, {
      connectionId: "work-drive",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.driveConnection.deleteMany).toHaveBeenCalledWith({
      where: {
        ...ownedBySameUser("personal"),
        provider: "google",
        email: { equals: "me@work.com", mode: "insensitive" },
        OR: [{ id: "work-drive" }, { emailAccountId: "personal" }],
      },
    });
  });

  it("refuses a drive outside the person's mailboxes", async () => {
    prisma.driveConnection.findFirst.mockResolvedValue(null);

    const result = await disconnectDriveAction("personal" as any, {
      connectionId: "someone-elses",
    });

    expect(result?.serverError).toBe("Drive connection not found");
    expect(prisma.driveConnection.deleteMany).not.toHaveBeenCalled();
  });
});
