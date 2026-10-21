import { describe, expect, it } from "vitest";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import type { HomeThread } from "@/utils/home/get-home";
import type { MeetingNews } from "@/utils/home/meeting-news";
import type { NextUpItem } from "@/utils/home/next-up";
import {
  type AccountHome,
  mergeHomeData,
  mergeMeetingNews,
  mergeNextUp,
} from "./merge-home";
import { HOME_LANE_LIMIT } from "./today-constants";

const A = { id: "account-a", email: "a@example.com" };
const B = { id: "account-b", email: "b@example.com" };

describe("mergeHomeData", () => {
  it("merges both accounts' lanes, each row naming its account, in one account's order", () => {
    const { data, failedAccountIds } = mergeHomeData([
      loaded(A, {
        needsYou: [
          thread("a-low", { priority: "low", at: "2026-10-14T09:00:00Z" }),
          thread("a-medium", { at: "2026-10-12T09:00:00Z" }),
        ],
        waiting: [thread("a-wait", { at: "2026-10-10T09:00:00Z" })],
      }),
      loaded(B, {
        needsYou: [
          thread("b-high", { priority: "high", at: "2026-10-11T09:00:00Z" }),
          thread("b-medium", { at: "2026-10-13T09:00:00Z" }),
        ],
        waiting: [thread("b-wait", { at: "2026-10-11T09:00:00Z" })],
        alsoInInbox: [thread("b-inbox")],
      }),
    ]);

    expect(failedAccountIds).toEqual([]);
    // Priority first, then newest.
    expect(
      data?.needsYou.map((row) => [row.threadId, row.account?.id]),
    ).toEqual([
      ["b-high", B.id],
      ["b-medium", B.id],
      ["a-medium", A.id],
      ["a-low", A.id],
    ]);
    expect(data?.waiting.map((row) => row.threadId)).toEqual([
      "b-wait",
      "a-wait",
    ]);
    expect(data?.alsoInInbox.map((row) => row.account)).toEqual([B]);
  });

  it("caps each lane as one account's are, and says it is capped", () => {
    const many = (prefix: string) =>
      Array.from({ length: 7 }, (_, index) => thread(`${prefix}-${index}`));
    const { data } = mergeHomeData([
      loaded(A, { needsYou: many("a") }),
      loaded(B, { needsYou: many("b") }),
    ]);

    expect(data?.needsYou).toHaveLength(HOME_LANE_LIMIT);
    expect(data?.stats.needsYouCapped).toBe(true);
    expect(data?.stats.needsYou).toBe(HOME_LANE_LIMIT);
  });

  it("sums the stats and today's activity, and ORs capped flags", () => {
    const { data } = mergeHomeData([
      loaded(A, {
        needsYou: [thread("a1")],
        today: { checked: 10, filed: 2, filedLabel: null },
        stats: { ...stats(), agentWorking: 1, waitingCapped: true },
      }),
      loaded(B, {
        needsYou: [thread("b1"), thread("b2")],
        today: { checked: 5, filed: 3, filedLabel: null },
        stats: { ...stats(), agentWorking: 2 },
      }),
    ]);

    expect(data?.today).toEqual({ checked: 15, filed: 5, filedLabel: null });
    expect(data?.stats).toMatchObject({
      needsYou: 3,
      estimatedMinutes: 9,
      agentWorking: 3,
      waitingCapped: true,
      needsYouCapped: false,
    });
  });

  it("links filed mail to its label only when one account filed it, in that account", () => {
    const label = { labelId: "Label_News", name: "Newsletter" };
    const one = mergeHomeData([
      loaded(A, { today: { checked: 3, filed: 2, filedLabel: label } }),
      loaded(B, { today: { checked: 3, filed: 0, filedLabel: null } }),
    ]);
    expect(one.data?.today.filedLabel).toEqual({
      ...label,
      accountId: A.id,
    });

    const both = mergeHomeData([
      loaded(A, { today: { checked: 3, filed: 2, filedLabel: label } }),
      loaded(B, { today: { checked: 3, filed: 1, filedLabel: label } }),
    ]);
    expect(both.data?.today.filedLabel).toBeNull();
  });

  it("keeps an account still loading pending, with the other's rows shown", () => {
    const { data, failedAccountIds } = mergeHomeData([
      loaded(A, { needsYou: [thread("a1")] }),
      { account: B, gaveUp: false },
    ]);

    expect(data?.needsYou.map((row) => row.threadId)).toEqual(["a1"]);
    expect(data?.pending).toEqual(["needsYou", "waiting", "alsoInInbox"]);
    expect(failedAccountIds).toEqual([]);
  });

  it("keeps one account's pending lane pending until it gives up, then reports the account", () => {
    const waitingPending = loaded(B, { pending: ["waiting"] });
    expect(mergeHomeData([loaded(A), waitingPending]).data?.pending).toEqual([
      "waiting",
    ]);

    const gaveUp = mergeHomeData([
      loaded(A),
      { ...waitingPending, gaveUp: true },
    ]);
    expect(gaveUp.data?.pending).toEqual([]);
    expect(gaveUp.data?.failed).toEqual(["waiting"]);
    expect(gaveUp.failedAccountIds).toEqual([B.id]);
  });

  it("a failed account leaves the other's rows and marks every lane failed, never all clear", () => {
    const { data, failedAccountIds } = mergeHomeData([
      loaded(A, { needsYou: [] }),
      { account: B, error: new Error("Boom"), gaveUp: false },
    ]);

    expect(data?.needsYou).toEqual([]);
    expect(data?.failed).toEqual(["needsYou", "waiting", "alsoInInbox"]);
    expect(failedAccountIds).toEqual([B.id]);
  });

  it("reports an account whose lane failed to load", () => {
    const { data, failedAccountIds } = mergeHomeData([
      loaded(A, { needsYou: [thread("a1")] }),
      loaded(B, { failed: ["needsYou"] }),
    ]);

    expect(data?.needsYou).toHaveLength(1);
    expect(data?.failed).toEqual(["needsYou"]);
    expect(failedAccountIds).toEqual([B.id]);
  });

  it("has nothing to show until an account has loaded", () => {
    expect(
      mergeHomeData([
        { account: A, gaveUp: false },
        { account: B, error: new Error("Boom"), gaveUp: false },
      ]),
    ).toEqual({ data: null, failedAccountIds: [B.id] });
  });

  it("shows a conversation in both mailboxes once, in the lane that asks most, saying where else it is", () => {
    const { data } = mergeHomeData([
      loaded(A, {
        alsoInInbox: [thread("a-copy", { rfcMessageId: "<same@mail>" })],
      }),
      loaded(B, {
        needsYou: [thread("b-copy", { rfcMessageId: " SAME@mail " })],
      }),
    ]);

    expect(data?.needsYou.map((row) => [row.threadId, row.alsoIn])).toEqual([
      ["b-copy", [A]],
    ]);
    expect(data?.alsoInInbox).toEqual([]);
  });

  it("does not drop rows of one mailbox that share a message, as one account's Today wouldn't", () => {
    const { data } = mergeHomeData([
      loaded(A, {
        needsYou: [thread("one", { rfcMessageId: "<same@mail>" })],
        waiting: [thread("one", { rfcMessageId: "<same@mail>" })],
      }),
    ]);

    expect(data?.needsYou).toHaveLength(1);
    expect(data?.waiting).toHaveLength(1);
  });

  it("names the account a reply-tracking notice is about", () => {
    const { data } = mergeHomeData([
      loaded(A),
      loaded(B, {
        cue: { aiAccess: true, replyTracking: false, hasReadMail: true },
      }),
    ]);

    expect(data?.cue).toEqual({
      aiAccess: true,
      replyTracking: false,
      hasReadMail: true,
      replyTrackingOffAccount: B,
    });
  });

  it("names each notice's own account when accounts lack different things", () => {
    const { data } = mergeHomeData([
      loaded(A, {
        cue: { aiAccess: true, replyTracking: true, hasReadMail: false },
      }),
      loaded(B, {
        cue: { aiAccess: true, replyTracking: false, hasReadMail: true },
      }),
    ]);

    expect(data?.cue).toMatchObject({
      replyTrackingOffAccount: B,
      readingAccount: A,
    });
  });

  it("a row past a lane's cap doesn't hide the conversation's copy in another account", () => {
    const newer = Array.from({ length: HOME_LANE_LIMIT }, (_, index) =>
      thread(`a-${index}`, { at: `2026-10-14T0${index % 10}:00:00Z` }),
    );
    const { data } = mergeHomeData([
      loaded(A, {
        needsYou: [
          ...newer,
          thread("a-old", {
            at: "2026-10-01T09:00:00Z",
            rfcMessageId: "<shared@mail>",
          }),
        ],
      }),
      loaded(B, {
        alsoInInbox: [thread("b-copy", { rfcMessageId: "<shared@mail>" })],
      }),
    ]);

    expect(data?.needsYou.map((row) => row.threadId)).not.toContain("a-old");
    expect(data?.stats.needsYouCapped).toBe(true);
    expect(data?.alsoInInbox.map((row) => row.threadId)).toEqual(["b-copy"]);
  });

  it("takes the earliest next meeting and keeps tasks with their account", () => {
    const { data } = mergeHomeData([
      loaded(A, {
        calendar: {
          connected: true,
          clearThroughTomorrow: false,
          next: {
            title: "Late",
            at: "2026-10-14T15:00:00Z",
            url: undefined,
            tomorrow: false,
          },
        },
        agentTasks: [
          {
            id: "task",
            kind: "draft",
            threadId: "t",
            title: "Reply draft",
            detail: "Draft ready for your review",
            at: "2026-10-14T09:00:00Z",
          },
        ],
      }),
      loaded(B, {
        calendar: {
          connected: false,
          clearThroughTomorrow: false,
          next: {
            title: "Early",
            at: "2026-10-14T10:00:00Z",
            url: undefined,
            tomorrow: false,
          },
        },
      }),
    ]);

    expect(data?.calendar).toEqual({
      connected: true,
      clearThroughTomorrow: false,
      next: {
        title: "Early",
        at: "2026-10-14T10:00:00Z",
        url: undefined,
        tomorrow: false,
      },
    });
    expect(data?.agentTasks.map((task) => task.account)).toEqual([A]);
  });

  it("calls the calendar clear only when every account that reads it found it clear", () => {
    const calendar = (connected: boolean, clearThroughTomorrow: boolean) => ({
      calendar: { connected, clearThroughTomorrow, next: null },
    });
    const clear = (...homes: Partial<GetHomeResponse>[]) =>
      mergeHomeData([loaded(A, homes[0]), loaded(B, homes[1])]).data?.calendar
        .clearThroughTomorrow;

    expect(clear(calendar(true, true), calendar(true, true))).toBe(true);
    // An account with no calendar has nothing to say about it.
    expect(clear(calendar(true, true), calendar(false, false))).toBe(true);
    // One account couldn't read it in time, or found a meeting.
    expect(clear(calendar(true, true), calendar(true, false))).toBe(false);
    expect(clear(calendar(false, false), calendar(false, false))).toBe(false);
  });
});

describe("mergeNextUp", () => {
  it("shows a meeting on both calendars once, and keeps different ones", () => {
    const review = event("a:review", "Design review", "10:00", "11:00");
    const items = mergeNextUp([
      [review, event("a:standup", "Standup", "09:00", "09:15")],
      [
        { ...event("b:review", " design  REVIEW ", "10:00", "11:00") },
        event("b:review-long", "Design review", "10:00", "12:00"),
      ],
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "a:standup",
      "a:review",
      "b:review-long",
    ]);
  });

  it("shows each deadline once though every account reports it", () => {
    const due: NextUpItem = {
      id: "canvas:4",
      kind: "deadline",
      title: "Problem set 4",
      at: "2026-10-15T23:59:00Z",
      source: "Canvas",
    };

    expect(mergeNextUp([[due], [{ ...due }]])).toEqual([due]);
  });

  it("shows the soonest four", () => {
    const items = mergeNextUp([
      ["08:00", "09:00", "10:00"].map((at) => event(`a:${at}`, at, at, at)),
      ["07:00", "11:00"].map((at) => event(`b:${at}`, at, at, at)),
    ]);

    expect(items.map((item) => item.id)).toEqual([
      "b:07:00",
      "a:08:00",
      "a:09:00",
      "a:10:00",
    ]);
  });
});

describe("mergeMeetingNews", () => {
  it("shows an organization once, for its first meeting, soonest first", () => {
    const merged = mergeMeetingNews([
      [meeting("a:renewal", "Acme", "2026-10-15T10:00:00Z")],
      [
        meeting("b:renewal", "acme", "2026-10-14T10:00:00Z"),
        meeting("b:waymo", "Waymo", "2026-10-16T10:00:00Z"),
      ],
    ]);

    expect(merged.map((m) => m.eventId)).toEqual(["b:renewal", "b:waymo"]);
  });
});

function loaded(
  account: { id: string; email: string },
  overrides: Partial<GetHomeResponse> = {},
): AccountHome {
  return { account, data: { ...home(), ...overrides }, gaveUp: false };
}

function home(): GetHomeResponse {
  return {
    needsYou: [],
    waiting: [],
    alsoInInbox: [],
    pending: [],
    failed: [],
    agentTasks: [],
    cue: { aiAccess: true, replyTracking: true, hasReadMail: true },
    today: { checked: 0, filed: 0, filedLabel: null },
    calendar: { connected: true, clearThroughTomorrow: false, next: null },
    nextUp: [],
    suggestion: null,
    stats: stats(),
  };
}

function stats(): GetHomeResponse["stats"] {
  return {
    needsYou: 0,
    estimatedMinutes: 0,
    agentWorking: 0,
    waiting: 0,
    needsYouCapped: false,
    waitingCapped: false,
  };
}

function thread(threadId: string, overrides: Partial<HomeThread> = {}) {
  return {
    threadId,
    fromName: "Grace Hopper",
    fromEmail: "grace@example.com",
    subject: threadId,
    preview: "",
    at: "2026-10-13T09:00:00.000Z",
    priority: "medium",
    unread: true,
    messageId: `${threadId}-message`,
    starred: false,
    inInbox: true,
    ...overrides,
  } satisfies HomeThread;
}

function event(
  id: string,
  title: string,
  start: string,
  end: string,
): NextUpItem {
  return {
    id,
    kind: "event",
    title,
    at: `2026-10-14T${start}:00.000Z`,
    endAt: `2026-10-14T${end}:00.000Z`,
    source: "Calendar",
  };
}

function meeting(
  eventId: string,
  organization: string,
  startTime: string,
): MeetingNews {
  return {
    eventId,
    title: eventId,
    startTime,
    organization,
    news: [{ title: "News", url: `https://news/${eventId}`, domain: "news" }],
  };
}
