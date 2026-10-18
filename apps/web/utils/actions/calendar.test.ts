import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { disconnectCalendarAction } from "@/utils/actions/calendar";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

describe("disconnectCalendarAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "user@example.com",
      account: { userId: "user-1", provider: "google" },
    } as any);
  });

  it("disconnects the calendar from this mailbox, leaving another mailbox's own copy for its briefs and recorder", async () => {
    prisma.calendarConnection.findFirst.mockResolvedValue({
      provider: "google",
      email: "me@work.com",
    } as any);

    const result = await disconnectCalendarAction("personal" as any, {
      connectionId: "work-connection",
    });

    expect(result?.serverError).toBeUndefined();
    expect(prisma.calendarConnection.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "work-connection", ...ownedBySameUser("personal") },
      }),
    );
    expect(prisma.calendarConnection.deleteMany).toHaveBeenCalledWith({
      where: {
        ...ownedBySameUser("personal"),
        provider: "google",
        email: { equals: "me@work.com", mode: "insensitive" },
        OR: [{ id: "work-connection" }, { emailAccountId: "personal" }],
      },
    });
  });

  it("refuses a connection outside the person's mailboxes", async () => {
    prisma.calendarConnection.findFirst.mockResolvedValue(null);

    const result = await disconnectCalendarAction("personal" as any, {
      connectionId: "someone-elses",
    });

    expect(result?.serverError).toBe("Calendar connection not found");
    expect(prisma.calendarConnection.deleteMany).not.toHaveBeenCalled();
  });
});
