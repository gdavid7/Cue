import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { getCalendarEventsTool } from "@/utils/ai/assistant/chat-calendar-tools";
import { createCalendarEventProviders } from "@/utils/calendar/event-provider";
import { SafeError } from "@/utils/error";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/posthog", () => ({ posthogCaptureEvent: vi.fn() }));
vi.mock("@/utils/calendar/event-provider", () => ({
  createCalendarEventProviders: vi.fn(),
}));

const logger = createTestLogger();

describe("getCalendarEvents chat tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes on the reason a calendar can't be read, such as needing a reconnect", async () => {
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      provider(async () => {
        throw new SafeError(
          "Your Google calendar authorization has expired. Please reconnect your calendar.",
        );
      }),
    ]);

    const result = await run({
      startDate: "2026-10-15T00:00:00Z",
      endDate: "2026-10-16T00:00:00Z",
    });

    expect(result).toEqual({
      error:
        "Your Google calendar authorization has expired. Please reconnect your calendar.",
    });
  });

  it("says the calendar needs reconnecting when its only connection was marked disconnected", async () => {
    vi.mocked(createCalendarEventProviders).mockResolvedValue([]);
    prisma.calendarConnection.count.mockResolvedValue(1);

    const result = await run({
      startDate: "2026-10-15T00:00:00Z",
      endDate: "2026-10-16T00:00:00Z",
    });

    expect(result.error).toMatch(/reconnect/i);
  });

  it("explains a date it can't read instead of failing generically", async () => {
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      provider(async () => []),
    ]);

    const result = await run({
      startDate: "next tuesday",
      endDate: "2026-10-16T00:00:00Z",
    });

    expect(result.error).toContain("startDate");
  });

  it("gives an all-day item as its date, not a shifted time", async () => {
    vi.mocked(createCalendarEventProviders).mockResolvedValue([
      provider(async () => [
        {
          id: "hw3",
          title: "HW 3 due",
          allDay: true,
          startTime: new Date("2026-10-20T00:00:00Z"),
          endTime: new Date("2026-10-21T00:00:00Z"),
          attendees: [],
        },
      ]),
    ]);

    const result = await run({
      startDate: "2026-10-20T00:00:00-07:00",
      endDate: "2026-10-21T00:00:00-07:00",
    });

    expect(result.events).toEqual([
      expect.objectContaining({
        title: "HW 3 due",
        allDay: true,
        startTime: "2026-10-20",
        endTime: "2026-10-20",
      }),
    ]);
  });
});

function provider(fetchEvents: () => Promise<unknown>) {
  return { fetchEvents } as never;
}

async function run(input: { startDate: string; endDate: string }) {
  const tool = getCalendarEventsTool({
    email: "student@ucsd.edu",
    emailAccountId: "account-1",
    logger,
  });
  return (await tool.execute!(input, {
    toolCallId: "1",
    messages: [],
  } as never)) as {
    error?: string;
    events?: unknown[];
  };
}
