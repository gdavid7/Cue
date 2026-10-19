import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { MeetingBriefingStatus } from "@/generated/prisma/enums";
import { createScopedLogger } from "@/utils/logger";
import { runMeetingBrief } from "./process";

vi.mock("@/utils/prisma");
vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  gatherContextForEvent: vi.fn(),
  aiGenerateMeetingBriefing: vi.fn(),
  sendBriefing: vi.fn(),
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
const claimedAt = new Date("2026-10-20T14:30:00.000Z");

describe("runMeetingBrief", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findMany.mockResolvedValue([]);
    prisma.meetingBriefing.create.mockResolvedValue({
      id: "briefing-b",
      createdAt: claimedAt,
      eventTitle: "Quarterly review",
      eventStartTime: startTime,
    } as never);
    mocks.gatherContextForEvent.mockResolvedValue({
      externalGuests: [{ email: "guest@other.example" }],
      internalTeamMembers: [],
    });
    mocks.aiGenerateMeetingBriefing.mockResolvedValue({ guests: [] });
    mocks.sendBriefing.mockResolvedValue(undefined);
  });

  it("briefs a meeting once when it is on two of the user's calendars", async () => {
    // The same meeting, claimed earlier from the user's other calendar.
    prisma.meetingBriefing.findMany.mockResolvedValue([
      { id: "briefing-a", createdAt: new Date(claimedAt.getTime() - 1000) },
    ] as never);

    const result = await runMeetingBrief({
      event: event(),
      emailAccount: emailAccount(),
      emailAccountId: "account-b",
      isTestSend: false,
      logger,
    });

    expect(result.success).toBe(false);
    expect(mocks.sendBriefing).not.toHaveBeenCalled();
    expect(prisma.meetingBriefing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: { not: "briefing-b" },
          emailAccount: { userId: "user-1" },
          eventStartTime: startTime,
        }),
      }),
    );
    expect(prisma.meetingBriefing.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: { status: MeetingBriefingStatus.SKIPPED },
      }),
    );
  });

  it("briefs the earliest claim when the other calendar claimed it later", async () => {
    prisma.meetingBriefing.findMany.mockResolvedValue([
      { id: "briefing-a", createdAt: new Date(claimedAt.getTime() + 1000) },
    ] as never);

    const result = await runMeetingBrief({
      event: event(),
      emailAccount: emailAccount(),
      emailAccountId: "account-b",
      isTestSend: false,
      logger,
    });

    expect(result.success).toBe(true);
    expect(mocks.sendBriefing).toHaveBeenCalledOnce();
  });
});

function event() {
  return {
    id: "event-on-calendar-b",
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
