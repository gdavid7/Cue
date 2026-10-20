import { addMinutes } from "date-fns/addMinutes";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestLogger } from "@/__tests__/helpers";
import { Prisma } from "@/generated/prisma/client";
import { MeetingBriefingStatus } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import type { CalendarEvent } from "@/utils/calendar/event-types";
import { aiGenerateMeetingBriefing } from "@/utils/ai/meeting-briefs/generate-briefing";
import { fetchUpcomingEvents } from "./fetch-upcoming-events";
import { gatherContextForEvent } from "./gather-context";
import { processUserMeetingBriefings } from "./process";
import { sendBriefing } from "./send-briefing";

vi.mock("@/utils/prisma");
vi.mock("./fetch-upcoming-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./fetch-upcoming-events")>()),
  fetchUpcomingEvents: vi.fn(),
}));
vi.mock("./gather-context", () => ({ gatherContextForEvent: vi.fn() }));
vi.mock("@/utils/ai/meeting-briefs/generate-briefing", () => ({
  aiGenerateMeetingBriefing: vi.fn(),
}));
vi.mock("./send-briefing", () => ({ sendBriefing: vi.fn() }));
vi.mock("@/utils/user/own-addresses", () => ({
  getUserOwnAddresses: vi.fn(async () => [
    "me@alpha.test",
    "me@beta.test",
    "me@gamma.test",
  ]),
}));

const logger = createTestLogger();
const NOW = new Date("2026-03-02T09:00:00Z");
const USER_ID = "user-1";

type Account = { id: string; email: string };
const ACCOUNT_A = { id: "acc-a", email: "me@alpha.test" };
const ACCOUNT_B = { id: "acc-b", email: "me@beta.test" };
const ACCOUNT_C = { id: "acc-c", email: "me@gamma.test" };

type Row = {
  emailAccountId: string;
  calendarEventId: string;
  status: MeetingBriefingStatus;
  createdAt: Date;
};

let rows: Row[];
let eventsByAccount: Record<string, CalendarEvent[]>;
let failingClaims: Set<string>;
let failingFetches: Set<string>;
let knownAccounts: Account[];

describe("processUserMeetingBriefings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    rows = [];
    eventsByAccount = {};
    failingClaims = new Set();
    failingFetches = new Set();
    knownAccounts = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C];
    mockBriefingStore();
    vi.mocked(fetchUpcomingEvents).mockImplementation(
      async ({ emailAccountId }) => {
        if (failingFetches.has(emailAccountId)) throw new Error("fetch failed");
        return eventsByAccount[emailAccountId] ?? [];
      },
    );
    vi.mocked(gatherContextForEvent).mockReset();
    vi.mocked(gatherContextForEvent).mockResolvedValue({
      externalGuests: [{ email: "guest@client.test" }],
      internalTeamMembers: [],
    } as never);
    vi.mocked(aiGenerateMeetingBriefing).mockReset();
    vi.mocked(aiGenerateMeetingBriefing).mockResolvedValue({} as never);
    vi.mocked(sendBriefing).mockReset();
    vi.mocked(sendBriefing).mockResolvedValue(undefined as never);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("briefs a meeting on several mailboxes once and skips the others after it is sent", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
    };

    await runTick([ACCOUNT_B, ACCOUNT_A]);

    expect(briefedCopies()).toEqual([["acc-a", "a-1"]]);
    expect(statusOf("acc-b", "b-1")).toBe(MeetingBriefingStatus.SKIPPED);
  });

  it("never chooses a placeholder copy with no attendees", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-hold", { attendees: [] })],
      [ACCOUNT_B.id]: [meeting("b-1")],
      [ACCOUNT_C.id]: [meeting("c-1")],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
    expect(statusOf("acc-c", "c-1")).toBe(MeetingBriefingStatus.SKIPPED);
  });

  it("takes over an unclaimed chosen copy near the start time", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 10 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 10 })],
    };
    failingClaims.add("acc-a");

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
  });

  it("takes over at once from a chosen copy that crashed before claiming, and the chosen copy then stands down", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 60 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 60 })],
    };
    failingClaims.add("acc-a");

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
    expect(statusOf("acc-a", "a-1")).toBeUndefined();

    failingClaims.clear();
    vi.setSystemTime(addMinutes(NOW, 15));
    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
    expect(statusOf("acc-a", "a-1")).toBe(MeetingBriefingStatus.SKIPPED);
  });

  it("briefs once when the chosen copy's calendar fetch fails on one tick and succeeds on the next", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 60 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 60 })],
    };
    failingFetches.add("acc-a");

    const firstTick = await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
    expect(firstTick.find((r) => r.emailAccountId === "acc-a")?.error).toEqual(
      expect.any(Error),
    );

    failingFetches.clear();
    vi.setSystemTime(addMinutes(NOW, 15));
    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
    expect(statusOf("acc-a", "a-1")).toBe(MeetingBriefingStatus.SKIPPED);
  });

  it("lets only the next copy in order take over a failed brief among three mailboxes", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
      [ACCOUNT_C.id]: [meeting("c-1")],
    };
    rows.push(row("acc-a", "a-1", MeetingBriefingStatus.FAILED));

    await runTick([ACCOUNT_C, ACCOUNT_B, ACCOUNT_A]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
    expect(statusOf("acc-c", "c-1")).toBe(MeetingBriefingStatus.SKIPPED);
  });

  it("falls through to the third mailbox when the takeover brief fails too", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
      [ACCOUNT_C.id]: [meeting("c-1")],
    };
    rows.push(row("acc-a", "a-1", MeetingBriefingStatus.FAILED));
    vi.mocked(sendBriefing).mockImplementation(async ({ emailAccountId }) => {
      if (emailAccountId === "acc-b") throw new Error("send failed");
    });

    await runTick([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);

    expect(briefedCopies()).toEqual([
      ["acc-b", "b-1"],
      ["acc-c", "c-1"],
    ]);
    expect(statusOf("acc-b", "b-1")).toBe(MeetingBriefingStatus.FAILED);
    expect(statusOf("acc-c", "c-1")).toBe(MeetingBriefingStatus.SENT);
  });

  it("takes over a chosen copy that has been pending past the cron's run limit", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 60 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 60 })],
    };
    rows.push(
      row("acc-a", "a-1", MeetingBriefingStatus.PENDING, addMinutes(NOW, -7)),
    );

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
  });

  it("waits once on a fresh pending copy, and briefs even if the next tick is missed", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 40 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 40 })],
    };
    rows.push(
      row("acc-a", "a-1", MeetingBriefingStatus.PENDING, addMinutes(NOW, -2)),
    );

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([]);
    expect(statusOf("acc-b", "b-1")).toBeUndefined();

    // The next tick is missed; the one after lands 10 minutes before start.
    vi.setSystemTime(addMinutes(NOW, 30));
    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
  });

  it("does not wait on a fresh pending copy when the next tick could land after the start", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 16 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 16 })],
    };
    rows.push(
      row("acc-a", "a-1", MeetingBriefingStatus.PENDING, addMinutes(NOW, -1)),
    );

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
  });

  it("keeps two different meetings with the same title and time apart", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [
        meeting("a-1", {
          attendees: [{ email: "me@alpha.test" }, { email: "x@client.test" }],
        }),
      ],
      [ACCOUNT_B.id]: [
        meeting("b-1", {
          attendees: [{ email: "me@beta.test" }, { email: "y@other.test" }],
        }),
      ],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([
      ["acc-a", "a-1"],
      ["acc-b", "b-1"],
    ]);
  });

  it("keeps meetings apart that share only an internal attendee or the user's own address", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [
        meeting("a-1", {
          attendees: [
            { email: "me@alpha.test" },
            { email: "interviewer@alpha.test" },
            { email: "candidate-1@client.test" },
          ],
        }),
        meeting("a-2", {
          attendees: [
            { email: "me@alpha.test" },
            { email: "interviewer@alpha.test" },
            { email: "candidate-2@other.test" },
          ],
        }),
      ],
      [ACCOUNT_B.id]: [
        meeting("b-1", {
          attendees: [
            { email: "me@alpha.test" },
            { email: "me@beta.test" },
            { email: "candidate-3@third.test" },
          ],
        }),
      ],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([
      ["acc-a", "a-1"],
      ["acc-a", "a-2"],
      ["acc-b", "b-1"],
    ]);
  });

  it("briefs a second copy on the same mailbox once, and takes over if the first fails", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-2"), meeting("a-1")],
    };

    await runTick([ACCOUNT_A]);

    expect(briefedCopies()).toEqual([["acc-a", "a-1"]]);
    expect(statusOf("acc-a", "a-2")).toBe(MeetingBriefingStatus.SKIPPED);

    rows = [];
    vi.mocked(sendBriefing).mockClear();
    vi.mocked(sendBriefing).mockImplementationOnce(async () => {
      throw new Error("send failed");
    });

    await runTick([ACCOUNT_A]);

    expect(briefedCopies()).toEqual([
      ["acc-a", "a-1"],
      ["acc-a", "a-2"],
    ]);
    expect(statusOf("acc-a", "a-2")).toBe(MeetingBriefingStatus.SENT);
  });

  it("briefs many mailboxes in parallel and starts no brief after the deadline", async () => {
    const accounts = Array.from({ length: 8 }, (_, index) => ({
      id: `acc-${index}`,
      email: `me@mailbox-${index}.test`,
    }));
    knownAccounts = accounts;
    eventsByAccount = Object.fromEntries(
      accounts.map((account) => [
        account.id,
        [meeting(`${account.id}-event`, { title: `Call ${account.id}` })],
      ]),
    );
    const deadline = new Date(NOW.getTime() + 240_000);
    let active = 0;
    let maxActive = 0;
    const startedAt: number[] = [];
    vi.mocked(aiGenerateMeetingBriefing).mockImplementation(async () => {
      startedAt.push(Date.now());
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      // Each brief takes a minute.
      vi.setSystemTime(Date.now() + 60_000);
      active--;
      return {} as never;
    });

    await runTick(accounts, deadline);

    expect(maxActive).toBeGreaterThan(1);
    expect(startedAt.length).toBeGreaterThan(0);
    expect(startedAt.every((time) => time < deadline.getTime())).toBe(true);
    const unclaimed = accounts.filter(
      (account) => !statusOf(account.id, `${account.id}-event`),
    );
    expect(unclaimed.length).toBeGreaterThan(0);
    expect(unclaimed.length + briefedCopies().length).toBe(accounts.length);
  });

  it("still briefs a meeting with no later tick after the deadline has passed", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-later", { title: "Later", startsIn: 40 })],
      [ACCOUNT_B.id]: [meeting("b-soon", { title: "Soon", startsIn: 10 })],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B], new Date(NOW.getTime() - 1000));

    expect(briefedCopies()).toEqual([["acc-b", "b-soon"]]);
    expect(statusOf("acc-a", "a-later")).toBeUndefined();
  });

  it("starts the soonest meetings first", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { title: "First", startsIn: 40 })],
      [ACCOUNT_B.id]: [meeting("b-1", { title: "Second", startsIn: 35 })],
      [ACCOUNT_C.id]: [meeting("c-1", { title: "Third", startsIn: 5 })],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B, ACCOUNT_C]);

    const gathered = vi
      .mocked(gatherContextForEvent)
      .mock.calls.map(([args]) => args.event.id);
    expect(gathered[0]).toBe("c-1");
  });

  it("retries a rate-limited brief once before marking it failed", async () => {
    eventsByAccount = { [ACCOUNT_A.id]: [meeting("a-1")] };
    vi.mocked(aiGenerateMeetingBriefing).mockRejectedValueOnce(
      Object.assign(new Error("Too many requests"), { status: 429 }),
    );

    const tick = runTick([ACCOUNT_A]);
    await vi.advanceTimersByTimeAsync(5000);
    await tick;

    expect(aiGenerateMeetingBriefing).toHaveBeenCalledTimes(2);
    expect(briefedCopies()).toEqual([["acc-a", "a-1"]]);
    expect(statusOf("acc-a", "a-1")).toBe(MeetingBriefingStatus.SENT);
  });

  it("does not retry a brief that failed for a lasting reason", async () => {
    eventsByAccount = { [ACCOUNT_A.id]: [meeting("a-1")] };
    vi.mocked(aiGenerateMeetingBriefing).mockRejectedValue(
      Object.assign(new Error("Invalid API key"), { status: 401 }),
    );

    await runTick([ACCOUNT_A]);

    expect(aiGenerateMeetingBriefing).toHaveBeenCalledTimes(1);
    expect(statusOf("acc-a", "a-1")).toBe(MeetingBriefingStatus.FAILED);
  });

  it("only reads briefing state from the user's own mailboxes", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    for (const [args] of prisma.meetingBriefing.findMany.mock.calls) {
      expect(args?.where?.emailAccount?.userId).toBe(USER_ID);
    }
    for (const [args] of prisma.emailAccount.findUnique.mock.calls) {
      expect(args.where.userId).toBe(USER_ID);
    }
  });
});

function runTick(
  accounts: Account[],
  deadline = new Date(Date.now() + 240_000),
) {
  return processUserMeetingBriefings({
    userId: USER_ID,
    emailAccounts: accounts.map((account) => ({
      ...account,
      meetingBriefingsMinutesBefore: 30,
    })),
    deadline,
    logger,
  });
}

function meeting(
  id: string,
  {
    startsIn = 30,
    title = "Quarterly review",
    attendees = [{ email: "guest@client.test" }],
  }: {
    startsIn?: number;
    title?: string;
    attendees?: CalendarEvent["attendees"];
  } = {},
): CalendarEvent {
  const startTime = addMinutes(NOW, startsIn);
  return {
    id,
    title,
    startTime,
    endTime: addMinutes(startTime, 30),
    attendees,
  };
}

function row(
  emailAccountId: string,
  calendarEventId: string,
  status: MeetingBriefingStatus,
  createdAt = addMinutes(NOW, -30),
): Row {
  return { emailAccountId, calendarEventId, status, createdAt };
}

function statusOf(emailAccountId: string, calendarEventId: string) {
  return rows.find(
    (r) =>
      r.emailAccountId === emailAccountId &&
      r.calendarEventId === calendarEventId,
  )?.status;
}

function briefedCopies() {
  return vi
    .mocked(sendBriefing)
    .mock.calls.map(([args]) => [args.emailAccountId, args.event.id]);
}

function mockBriefingStore() {
  prisma.emailAccount.findUnique.mockImplementation((async ({
    where,
  }: {
    where: { id: string; userId?: string };
  }) => {
    const account = knownAccounts.find((a) => a.id === where.id);
    if (!account || where.userId !== USER_ID) return null;
    return {
      ...account,
      userId: USER_ID,
      about: null,
      multiRuleSelectionEnabled: false,
      sensitiveDataPolicy: null,
      timezone: null,
      calendarBookingLink: null,
      user: { aiProvider: null, aiModel: null, aiApiKey: null },
      account: { provider: "google" },
    };
  }) as never);

  prisma.meetingBriefing.create.mockImplementation((async ({
    data,
  }: {
    data: Row;
  }) => {
    if (failingClaims.has(data.emailAccountId)) throw new Error("db down");
    if (statusOf(data.emailAccountId, data.calendarEventId)) {
      throw new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      });
    }
    rows.push({ ...data, createdAt: new Date() });
    return data;
  }) as never);

  prisma.meetingBriefing.upsert.mockImplementation((async ({
    create,
    update,
  }: {
    create: Row;
    update: { status: MeetingBriefingStatus };
  }) => {
    const existing = rows.find(
      (r) =>
        r.emailAccountId === create.emailAccountId &&
        r.calendarEventId === create.calendarEventId,
    );
    if (existing) existing.status = update.status;
    else rows.push({ ...create, createdAt: new Date() });
    return create;
  }) as never);

  prisma.meetingBriefing.findMany.mockImplementation((async ({
    where,
  }: {
    where: {
      emailAccount?: { userId: string };
      OR: { emailAccountId: string; calendarEventId: string }[];
    };
  }) =>
    rows.filter(
      (r) =>
        where.emailAccount?.userId === USER_ID &&
        where.OR.some(
          (pair) =>
            pair.emailAccountId === r.emailAccountId &&
            pair.calendarEventId === r.calendarEventId,
        ),
    )) as never);
}
