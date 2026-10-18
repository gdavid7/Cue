import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import { ownedBySameUser } from "@/utils/user/owned-by-same-user";

vi.mock("@/utils/prisma");

const { googleConstructor } = vi.hoisted(() => ({
  googleConstructor: vi.fn(),
}));
vi.mock("@/utils/calendar/providers/google-events", () => ({
  GoogleCalendarEventProvider: class {
    constructor(params: unknown) {
      googleConstructor(params);
    }
  },
}));
vi.mock("@/utils/calendar/providers/microsoft-events", () => ({
  MicrosoftCalendarEventProvider: class {},
}));

const logger = createTestLogger();

describe("createCalendarEventProviders", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reads every calendar the person connected, from any of their mailboxes, once each", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection({
        id: "a-work",
        emailAccountId: "personal",
        email: "me@work.com",
      }),
      connection({
        id: "b-work",
        emailAccountId: "work",
        email: "ME@work.com",
      }),
      connection({
        id: "c-home",
        emailAccountId: "personal",
        email: "me@home.com",
      }),
    ] as never);

    const providers = await createCalendarEventProviders("work", logger);

    expect(prisma.calendarConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ...ownedBySameUser("work"), isConnected: true },
      }),
    );
    expect(providers).toHaveLength(2);
    // Each provider saves refreshed tokens against its own mailbox.
    expect(googleConstructor.mock.calls.map(([params]) => params)).toEqual([
      expect.objectContaining({
        connectionId: "a-work",
        emailAccountId: "personal",
      }),
      expect.objectContaining({
        connectionId: "c-home",
        emailAccountId: "personal",
      }),
    ]);
  });

  it("keeps to the account's own calendars when asked", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([]);

    await createCalendarEventProviders("work", logger, {
      ownConnectionsOnly: true,
    });

    expect(prisma.calendarConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { emailAccountId: "work", isConnected: true },
      }),
    );
  });
});

function connection({
  id,
  emailAccountId,
  email,
}: {
  id: string;
  emailAccountId: string;
  email: string;
}) {
  return {
    id,
    emailAccountId,
    email,
    provider: "google",
    accessToken: "access",
    refreshToken: "refresh",
    expiresAt: null,
    calendars: [{ calendarId: "primary" }],
  };
}
