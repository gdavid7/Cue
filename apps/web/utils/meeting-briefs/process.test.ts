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

describe("processUserMeetingBriefings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    rows = [];
    eventsByAccount = {};
    failingClaims = new Set();
    mockBriefingStore();
    vi.mocked(fetchUpcomingEvents).mockImplementation(
      async ({ emailAccountId }) => eventsByAccount[emailAccountId] ?? [],
    );
    vi.mocked(gatherContextForEvent).mockResolvedValue({
      externalGuests: [{ email: "guest@client.test" }],
      internalTeamMembers: [],
    } as never);
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

  it("takes over an unclaimed chosen copy once the meeting is within one cron interval", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 10 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 10 })],
    };
    failingClaims.add("acc-a");

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
  });

  it("waits for an unclaimed chosen copy while a later tick can still brief it", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1", { startsIn: 40 })],
      [ACCOUNT_B.id]: [meeting("b-1", { startsIn: 40 })],
    };
    failingClaims.add("acc-a");

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([]);
    expect(statusOf("acc-b", "b-1")).toBeUndefined();

    failingClaims.clear();
    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-a", "a-1"]]);
    expect(statusOf("acc-b", "b-1")).toBe(MeetingBriefingStatus.SKIPPED);
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
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
    };
    rows.push(
      row("acc-a", "a-1", MeetingBriefingStatus.PENDING, addMinutes(NOW, -7)),
    );

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([["acc-b", "b-1"]]);
  });

  it("waits on a chosen copy that is still pending within the run limit", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
    };
    rows.push(
      row("acc-a", "a-1", MeetingBriefingStatus.PENDING, addMinutes(NOW, -2)),
    );

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    expect(briefedCopies()).toEqual([]);
    expect(statusOf("acc-b", "b-1")).toBeUndefined();
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

  it("only reads briefing state from the user's own mailboxes", async () => {
    eventsByAccount = {
      [ACCOUNT_A.id]: [meeting("a-1")],
      [ACCOUNT_B.id]: [meeting("b-1")],
    };

    await runTick([ACCOUNT_A, ACCOUNT_B]);

    for (const [args] of prisma.meetingBriefing.findMany.mock.calls) {
      const where = args?.where;
      expect(
        where?.emailAccount?.userId === USER_ID ||
          [ACCOUNT_A.id, ACCOUNT_B.id].includes(
            where?.emailAccountId as string,
          ),
      ).toBe(true);
    }
    for (const [args] of prisma.emailAccount.findUnique.mock.calls) {
      expect(args.where.userId).toBe(USER_ID);
    }
  });
});

function runTick(accounts: { id: string; email: string }[]) {
  return processUserMeetingBriefings({
    userId: USER_ID,
    emailAccounts: accounts.map((account) => ({
      ...account,
      meetingBriefingsMinutesBefore: 30,
    })),
    logger,
  });
}

function meeting(
  id: string,
  {
    startsIn = 30,
    attendees = [{ email: "guest@client.test" }],
  }: { startsIn?: number; attendees?: CalendarEvent["attendees"] } = {},
): CalendarEvent {
  const startTime = addMinutes(NOW, startsIn);
  return {
    id,
    title: "Quarterly review",
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
    const account = [ACCOUNT_A, ACCOUNT_B, ACCOUNT_C].find(
      (a) => a.id === where.id,
    );
    if (!account || (where.userId && where.userId !== USER_ID)) return null;
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
      emailAccountId?: string;
      calendarEventId?: { in: string[] };
      OR?: { emailAccountId: string; calendarEventId: string }[];
    };
  }) =>
    rows.filter(
      (r) =>
        (!where.emailAccountId || r.emailAccountId === where.emailAccountId) &&
        (!where.calendarEventId ||
          where.calendarEventId.in.includes(r.calendarEventId)) &&
        (!where.OR ||
          where.OR.some(
            (pair) =>
              pair.emailAccountId === r.emailAccountId &&
              pair.calendarEventId === r.calendarEventId,
          )),
    )) as never);
}
