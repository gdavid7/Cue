import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { fetchCalendarEventsInWindow } from "@/utils/calendar/fetch-events-in-window";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { getNextUp } from "@/utils/home/next-up";
import prisma from "@/utils/__mocks__/prisma";

vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({ redis: { get: vi.fn(), set: vi.fn() } }));
vi.mock("@/utils/calendar/fetch-events-in-window", () => ({
  fetchCalendarEventsInWindow: vi.fn(),
}));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({ isConfigured: () => false }),
}));

const NOW = new Date("2026-10-20T09:00:00.000Z");

describe("getNextUp", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.mcpConnection.findMany.mockResolvedValue([]);
    vi.mocked(fetchCalendarEventsInWindow).mockResolvedValue({
      complete: true,
      events: [
        event("standup", "Standup", 1, "me@gmail.example"),
        event("dentist", "Dentist", 2, "me@outlook.example"),
      ],
    });
  });

  it("names each meeting's calendar when the user has more than one", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection("google", "me@gmail.example"),
      connection("microsoft", "me@outlook.example"),
    ] as never);

    const { nextUp } = await nextUpFor();

    expect(nextUp.map(({ title, detail }) => [title, detail])).toEqual([
      ["Standup", "me@gmail.example"],
      ["Dentist", "me@outlook.example"],
    ]);
  });

  it("says only Calendar when there is one calendar to tell apart", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection("google", "me@gmail.example"),
      connection("google", "ME@gmail.example"),
    ] as never);

    const { nextUp } = await nextUpFor();

    expect(nextUp.map(({ source, detail }) => [source, detail])).toEqual([
      ["Calendar", undefined],
      ["Calendar", undefined],
    ]);
  });

  it("does not count a disconnected calendar as a second one", async () => {
    prisma.calendarConnection.findMany.mockResolvedValue([
      connection("google", "me@gmail.example"),
      connection("microsoft", "me@outlook.example", { isConnected: false }),
    ] as never);

    const { nextUp } = await nextUpFor();

    expect(nextUp.map(({ source, detail }) => [source, detail])).toEqual([
      ["Calendar", undefined],
      ["Calendar", undefined],
    ]);
  });
});

function nextUpFor() {
  return getNextUp({
    emailAccountId: "account",
    ownAddresses: ["me@gmail.example", "me@outlook.example"],
    timeZone: "UTC",
    logger: createTestLogger(),
    now: NOW,
  });
}

let connectionId = 0;
function connection(
  provider: string,
  email: string,
  { isConnected = true }: { isConnected?: boolean } = {},
) {
  connectionId += 1;
  return { id: `connection-${connectionId}`, provider, email, isConnected };
}

function event(
  id: string,
  title: string,
  hoursFromNow: number,
  calendarEmail: string,
): CalendarEvent {
  const startTime = new Date(NOW.getTime() + hoursFromNow * 3_600_000);
  return {
    id,
    title,
    startTime,
    endTime: new Date(startTime.getTime() + 1_800_000),
    attendees: [],
    calendarEmail,
  };
}
