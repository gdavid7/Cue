import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { MeetingBriefingStatus } from "@/generated/prisma/enums";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { createScopedLogger } from "@/utils/logger";
import { processMeetingBriefings } from "./process";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  eventsByAccount: {} as Record<string, unknown[]>,
  gatherContextForEvent: vi.fn(),
  aiGenerateMeetingBriefing: vi.fn(),
  sendBriefing: vi.fn(),
}));
vi.mock("./fetch-upcoming-events", async (importActual) => ({
  ...(await importActual<typeof import("./fetch-upcoming-events")>()),
  fetchUpcomingEvents: async ({ emailAccountId }: { emailAccountId: string }) =>
    mocks.eventsByAccount[emailAccountId] ?? [],
}));
vi.mock("@/utils/user/own-addresses", () => ({
  getUserOwnAddresses: async () => [],
}));
vi.mock("./gather-context", () => ({
  gatherContextForEvent: mocks.gatherContextForEvent,
}));
vi.mock("@/utils/ai/meeting-briefs/generate-briefing", () => ({
  aiGenerateMeetingBriefing: mocks.aiGenerateMeetingBriefing,
}));
vi.mock("./send-briefing", () => ({ sendBriefing: mocks.sendBriefing }));

const logger = createScopedLogger("meeting-briefs-test");
const startTime = new Date("2026-10-20T15:00:00.000Z");

describe("processMeetingBriefings with one meeting on two mailboxes' calendars", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The same meeting, with a different event id on each calendar.
    mocks.eventsByAccount = {
      "account-a": [event("event-on-a")],
      "account-b": [event("event-on-b")],
    };
    prisma.emailAccount.findUnique.mockResolvedValue(emailAccount() as never);
    prisma.emailAccount.findMany.mockResolvedValue([
      { id: "account-a" },
    ] as never);
    prisma.meetingBriefing.findMany.mockResolvedValue([]);
    prisma.meetingBriefing.create.mockResolvedValue({} as never);
    mocks.gatherContextForEvent.mockResolvedValue({
      externalGuests: [{ email: "guest@other.example" }],
      internalTeamMembers: [],
    });
    mocks.aiGenerateMeetingBriefing.mockResolvedValue({ guests: [] });
    mocks.sendBriefing.mockResolvedValue(undefined);
  });

  it("puts this copy away once the other mailbox's brief is sent", async () => {
    winnerBriefing({ status: MeetingBriefingStatus.SENT });

    await processB();

    expect(mocks.sendBriefing).not.toHaveBeenCalled();
    expect(prisma.meetingBriefing.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          emailAccountId_calendarEventId: {
            emailAccountId: "account-a",
            calendarEventId: "event-on-a",
          },
        },
      }),
    );
    expect(prisma.meetingBriefing.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          emailAccountId: "account-b",
          calendarEventId: "event-on-b",
          status: MeetingBriefingStatus.SKIPPED,
        }),
      }),
    );
  });

  it("waits, without claiming, while the other mailbox has yet to brief it", async () => {
    prisma.meetingBriefing.findUnique.mockResolvedValue(null);

    await processB();

    expect(mocks.sendBriefing).not.toHaveBeenCalled();
    expect(prisma.meetingBriefing.create).not.toHaveBeenCalled();
    expect(prisma.meetingBriefing.upsert).not.toHaveBeenCalled();
  });

  it("waits while the other mailbox's brief is recently pending", async () => {
    winnerBriefing({
      status: MeetingBriefingStatus.PENDING,
      createdAt: new Date(Date.now() - 60_000),
    });

    await processB();

    expect(mocks.sendBriefing).not.toHaveBeenCalled();
    expect(prisma.meetingBriefing.create).not.toHaveBeenCalled();
  });

  it.each([
    ["failed", MeetingBriefingStatus.FAILED, new Date()],
    [
      "stalled",
      MeetingBriefingStatus.PENDING,
      new Date(Date.now() - 20 * 60_000),
    ],
  ])("briefs it itself when the other mailbox's brief %s", async (_case, status, createdAt) => {
    winnerBriefing({ status, createdAt });

    await processB();

    expect(mocks.sendBriefing).toHaveBeenCalledOnce();
  });

  it("briefs a meeting only on its own calendars as before", async () => {
    mocks.eventsByAccount["account-a"] = [];

    await processB();

    expect(prisma.meetingBriefing.findUnique).not.toHaveBeenCalled();
    expect(mocks.sendBriefing).toHaveBeenCalledOnce();
  });
});

function processB() {
  return processMeetingBriefings({
    emailAccountId: "account-b",
    userEmail: "me@work.example",
    minutesBefore: 30,
    logger,
  });
}

function winnerBriefing(input: {
  status: MeetingBriefingStatus;
  createdAt?: Date;
}) {
  prisma.meetingBriefing.findUnique.mockResolvedValue({
    status: input.status,
    createdAt: input.createdAt ?? new Date(),
  } as never);
}

function event(id: string): CalendarEvent {
  return {
    id,
    title: "Quarterly review",
    startTime,
    endTime: new Date(startTime.getTime() + 30 * 60_000),
    attendees: [{ email: "me@work.example" }, { email: "guest@other.example" }],
  };
}

function emailAccount() {
  return {
    id: "account-b",
    userId: "user-1",
    email: "me@work.example",
    about: null,
    multiRuleSelectionEnabled: false,
    sensitiveDataPolicy: null,
    timezone: null,
    calendarBookingLink: null,
    user: { aiProvider: null, aiModel: null, aiApiKey: null },
    account: { provider: "google" },
  };
}
