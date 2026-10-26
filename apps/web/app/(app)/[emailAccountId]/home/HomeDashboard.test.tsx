// @vitest-environment jsdom

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetCalendarTodayEventsResponse } from "@/app/api/user/calendar/upcoming-events/route";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { ShortcutsProvider } from "@/lib/shortcuts/ShortcutsProvider";
import { MAIL_SHORTCUT_SCOPES } from "@/lib/shortcuts/registry";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";
import type { HomeThread } from "@/utils/home/get-home";
import type { TodayThread } from "@/utils/home/merge-home";
import type { NextUpItem } from "@/utils/home/next-up";
import type {
  ConversationSummary,
  MailboxView,
  RecentBounce,
} from "@inboxzero/mail-core/queries";
import type { useLocalInboxRows } from "./use-local-inbox-rows";
import { readCachedToday, writeCachedToday } from "@/utils/home/today-cache";
import type { CatchUpEntry } from "@/app/(app)/[emailAccountId]/mail/CatchUp";
import type { CatchUpItem } from "@/app/(app)/[emailAccountId]/mail/catch-up-queue";
import { HomeDashboard } from "./HomeDashboard";

const mocks = vi.hoisted(() => ({
  client: {
    cancelOperation: vi.fn(),
    getDiagnostics: vi.fn(),
    submitConversations: vi.fn(),
  },
  push: vi.fn(),
  searchParams: new URLSearchParams(),
  emailAccounts: [] as unknown[] | undefined,
  homes: {} as Record<string, GetHomeResponse | undefined>,
  // Work due in connected apps, which loads after Today.
  deadlines: undefined as NextUpItem[] | undefined,
  markNeedsReply: vi.fn(),
  markNoReplyNeeded: vi.fn(),
  toastUndo: vi.fn(),
  undoLatestToast: vi.fn(),
  // The browser's own inbox, as the mail engine lists it.
  localInbox: null as ConversationSummary[] | null,
  localInboxArgs: [] as Parameters<typeof useLocalInboxRows>[0][],
  // Today's meetings, as the calendar answers for the Your day strip.
  // `undefined` while the calendar is still being read.
  day: { events: [], more: 0 } as GetCalendarTodayEventsResponse | undefined,
  // What Waiting on you reads from local mail.
  waitingOnYou: [] as TodayThread[],
  dismissWaitingOnYou: vi.fn(),
  // Recent bounces in local mail, and which of them were dismissed.
  bounces: [] as RecentBounce[],
  dismissedBounces: [] as string[],
  // By account, whether Cue has read the mailbox, asked before Today's answer.
  homeCue: undefined as Record<string, boolean> | undefined,
  reportActivation: vi.fn(),
  catchUpProps: [] as Array<Record<string, unknown>>,
  home: {
    isLoading: false,
    data: undefined as GetHomeResponse | undefined,
    error: undefined as { error: string; status?: number } | undefined,
    gaveUp: false,
    retry: vi.fn(),
  },
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
  useSearchParams: () => mocks.searchParams,
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: mocks.emailAccounts
      ? { emailAccounts: mocks.emailAccounts }
      : undefined,
  }),
}));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mocks.client,
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("@/components/Toast", () => ({
  toastError: vi.fn(),
  toastSuccess: vi.fn(),
  toastUndo: mocks.toastUndo,
  undoLatestToast: mocks.undoLatestToast,
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({
    emailAccountId: "account",
    emailAccount: { name: "Ada Lovelace" },
    userEmail: "ada@example.com",
    accountIds: ["account", "account-b"],
  }),
}));
vi.mock("@/hooks/useMailHref", () => ({
  useMailHref:
    () =>
    ({
      threadId,
      view,
      accountId,
      allInboxes,
      threadAccountIndex,
    }: {
      threadId?: string;
      view?: { kind: string; slug: string };
      accountId?: string;
      allInboxes?: boolean;
      threadAccountIndex?: number;
    } = {}) => {
      const index = accountId === "account-b" ? 1 : 0;
      if (view) return `/mail/u/${index}/${view.kind}/${view.slug}`;
      if (allInboxes)
        return `/mail/u/0/all-inboxes/inbox/${threadId}?account=${threadAccountIndex}`;
      return `/mail/u/${index}/inbox${threadId ? `/${threadId}` : ""}`;
    },
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsLargeScreen: () => true }));
vi.mock("@/hooks/useActivationSignal", () => ({
  reportActivationSignal: mocks.reportActivation,
}));
vi.mock("@/hooks/useHome", () => ({
  useHomeDeadlines: () => mocks.deadlines,
  useHomeCue: (_accountIds: string[], enabled: boolean) =>
    enabled ? mocks.homeCue : undefined,
  // A stand-in for SWR's cache: local mutations apply, nothing revalidates.
  useHome: (emailAccountId?: string | null) => {
    const [data, setData] = useState(
      emailAccountId && emailAccountId in mocks.homes
        ? mocks.homes[emailAccountId]
        : mocks.home.data,
    );
    return {
      data,
      isLoading: mocks.home.isLoading && !data,
      error: mocks.home.error,
      gaveUp: mocks.home.gaveUp,
      retry: mocks.home.retry,
      mutate: (
        update?:
          | GetHomeResponse
          | ((current?: GetHomeResponse) => GetHomeResponse | undefined),
      ) => {
        if (update === undefined) return;
        setData((current) =>
          typeof update === "function" ? update(current) : update,
        );
      },
    };
  },
}));
vi.mock("@/utils/actions/rule-feedback", () => ({
  markNoReplyNeededAction: mocks.markNoReplyNeeded,
}));
vi.mock("@/utils/actions/thread-assist", () => ({
  markNeedsReplyAction: mocks.markNeedsReply,
}));
vi.mock("./use-local-inbox-rows", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./use-local-inbox-rows")>();
  return {
    ...actual,
    useLocalInboxRows: (args: Parameters<typeof useLocalInboxRows>[0]) => {
      mocks.localInboxArgs.push(args);
      if (!args.enabled || !mocks.localInbox) return null;
      return actual.localInboxRows(
        syncedView(mocks.localInbox, args.accounts),
        args,
      );
    },
  };
});
vi.mock("@/hooks/useCalendarUpcomingEvents", () => ({
  useCalendarTodayEvents: () => ({ data: mocks.day }),
}));
vi.mock("./use-waiting-on-you", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-waiting-on-you")>();
  return {
    ...actual,
    // What the hook found in the accounts it reads, whether or not Today
    // still wants it.
    useWaitingOnYou: ({
      accounts,
      handledLabelIds,
    }: Parameters<typeof actual.useWaitingOnYou>[0]) => ({
      threads: mocks.waitingOnYou.filter(
        (thread) => (thread.account?.id ?? accounts[0]?.id) in handledLabelIds,
      ),
      dismiss: mocks.dismissWaitingOnYou,
    }),
  };
});
vi.mock("./use-recent-bounces", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./use-recent-bounces")>();
  return {
    ...actual,
    useRecentBounces: () => ({
      bounces: mocks.bounces
        .filter((bounce) => !mocks.dismissedBounces.includes(bounce.messageId))
        .map((bounce) => ({
          ...bounce,
          title: bounce.sentSubject ?? bounce.subject,
        })),
      dismiss: vi.fn(),
    }),
  };
});
vi.mock("@/app/(app)/[emailAccountId]/mail/CatchUp", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("@/app/(app)/[emailAccountId]/mail/CatchUp")
    >();
  return {
    ...actual,
    CatchUpEntry: (props: Record<string, unknown>) => {
      mocks.catchUpProps.push(props);
      return null;
    },
  };
});
vi.mock("./BeforeYourMeeting", () => ({ BeforeYourMeeting: () => null }));
vi.mock("./TodayWeather", () => ({ TodayWeather: () => null }));

describe("HomeDashboard row actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.client.submitConversations.mockResolvedValue({ status: "queued" });
    mocks.client.cancelOperation.mockResolvedValue({ status: "cancelled" });
    mocks.undoLatestToast.mockResolvedValue(false);
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.data = homeData([
      thread("first", "Quarterly numbers"),
      thread("second", "Lunch on Friday?"),
    ]);
  });

  afterEach(cleanup);

  it("offers one account's Catch up, without All inboxes", () => {
    mocks.catchUpProps = [];
    renderToday();

    expect(mocks.catchUpProps.at(-1)).toMatchObject({
      emailAccountId: "account",
      query: { type: "inbox" },
      allInboxes: undefined,
    });
  });

  it("archives through the mail engine, moves focus to the next row, and undo brings it back", async () => {
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("first")).getAllByRole("button", {
          name: "Archive conversation",
        })[0],
      );
    });

    expect(screen.queryByText("Quarterly numbers")).toBeNull();
    expect(document.activeElement).toBe(optionFor("second"));
    expect(mocks.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: [{ accountId: "account", conversationId: "first" }],
        change: { kind: "archive" },
      }),
    );

    const [{ message, onUndo }] = mocks.toastUndo.mock.calls[0];
    expect(message).toBe("Archived");
    await act(async () => onUndo());

    expect(screen.getByText("Quarterly numbers")).toBeTruthy();
    expect(mocks.client.cancelOperation).toHaveBeenCalled();
  });

  it("archives the focused row with e and restores it with z", async () => {
    renderToday();
    act(() => optionFor("second").focus());

    await act(async () => {
      fireEvent.keyDown(optionFor("second"), { key: "e", code: "KeyE" });
    });
    await waitFor(() =>
      expect(screen.queryByText("Lunch on Friday?")).toBeNull(),
    );
    // The last row went, so focus moves up to the one above it.
    expect(document.activeElement).toBe(optionFor("first"));

    await act(async () => {
      fireEvent.keyDown(optionFor("first"), { key: "z", code: "KeyZ" });
    });
    await waitFor(() =>
      expect(screen.getByText("Lunch on Friday?")).toBeTruthy(),
    );
  });

  it("puts the row back when the engine refuses the archive", async () => {
    mocks.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("first")).getAllByRole("button", {
          name: "Archive conversation",
        })[0],
      );
    });

    expect(screen.getByText("Quarterly numbers")).toBeTruthy();
    expect(mocks.toastUndo).not.toHaveBeenCalled();
  });

  it.each([
    "Archive conversation",
    "Delete conversation",
  ])("%s takes the row out of the saved copy too", async (action) => {
    window.localStorage.clear();
    resetBrowserCacheForTesting("user");
    const timeZone = "UTC";
    writeCachedToday({
      emailAccountId: "account",
      timeZone,
      data: mocks.home.data as GetHomeResponse,
    });
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("first")).getAllByRole("button", { name: action })[0],
      );
    });

    const saved = readCachedToday({ emailAccountId: "account", timeZone });
    expect(saved?.needsYou.map((row) => row.threadId)).toEqual(["second"]);
  });

  it("keeps a row the engine refused in the saved copy", async () => {
    mocks.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    window.localStorage.clear();
    resetBrowserCacheForTesting("user");
    const timeZone = "UTC";
    writeCachedToday({
      emailAccountId: "account",
      timeZone,
      data: mocks.home.data as GetHomeResponse,
    });
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("first")).getAllByRole("button", {
          name: "Archive conversation",
        })[0],
      );
    });

    const saved = readCachedToday({ emailAccountId: "account", timeZone });
    expect(saved?.needsYou).toHaveLength(2);
  });

  it("opens the conversation with a reply started, returning to Today", () => {
    renderToday();

    fireEvent.click(
      within(rowFor("second")).getAllByRole("button", {
        name: "Reply to conversation",
      })[0],
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/mail/u/0/inbox/second?from=today&reply=1",
    );
  });
});

describe("HomeDashboard Nudge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.data = {
      ...homeData([thread("first", "Quarterly numbers")]),
      waiting: [thread("sent", "Contract draft")],
    };
  });

  afterEach(cleanup);

  it("is on Waiting on rows only, in place of Reply", () => {
    renderToday();

    expect(
      within(rowFor("sent")).getAllByRole("button", { name: NUDGE }).length,
    ).toBeGreaterThan(0);
    expect(
      within(rowFor("sent")).queryAllByRole("button", {
        name: "Reply to conversation",
      }),
    ).toHaveLength(0);
    expect(
      within(rowFor("first")).queryAllByRole("button", { name: NUDGE }),
    ).toHaveLength(0);
  });

  it("opens a reply on the conversation, returning to Today", () => {
    renderToday();

    fireEvent.click(
      within(rowFor("sent")).getAllByRole("button", { name: NUDGE })[0],
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/mail/u/0/inbox/sent?from=today&reply=1",
    );
  });

  it("nudges the focused Waiting on row with Shift+N, and no other row", () => {
    renderToday();

    act(() => optionFor("first").focus());
    fireEvent.keyDown(optionFor("first"), SHIFT_N);
    expect(mocks.push).not.toHaveBeenCalled();

    act(() => optionFor("sent").focus());
    fireEvent.keyDown(optionFor("sent"), SHIFT_N);
    expect(mocks.push).toHaveBeenCalledWith(
      "/mail/u/0/inbox/sent?from=today&reply=1",
    );
  });

  it("leaves Shift+N to the text while typing", () => {
    render(
      <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
        <input aria-label="Notes" />
        <HomeDashboard />
      </ShortcutsProvider>,
    );
    act(() => optionFor("sent").focus());
    const notes = screen.getByRole("textbox", { name: "Notes" });
    act(() => notes.focus());

    fireEvent.keyDown(notes, SHIFT_N);

    expect(mocks.push).not.toHaveBeenCalled();
  });
});

describe("HomeDashboard notices", () => {
  afterEach(cleanup);

  it("does not ask to turn on the assistant as if the lanes were empty", () => {
    const data = homeData([thread("first", "Quarterly numbers")]);
    mocks.home.data = { ...data, cue: { ...data.cue, aiAccess: false } };

    renderToday();

    // Earlier tracking still fills Needs reply, so the notice explains why
    // the lane may be stale instead of implying it would otherwise show up.
    expect(
      within(lane("Needs reply")).getByText("Quarterly numbers"),
    ).toBeTruthy();
    const notice = screen.getByRole("status");
    expect(notice.textContent).toContain("isn't being updated");
    expect(
      within(notice).getByRole("link", { name: "See plans" }),
    ).toBeTruthy();
    // A nag, not a section: it stays out of the heading outline.
    expect(within(notice).queryByRole("heading")).toBeNull();
  });

  it("asks to turn on the assistant when nothing has been tracked", () => {
    const data = homeData([]);
    mocks.home.data = { ...data, cue: { ...data.cue, aiAccess: false } };

    renderToday();

    expect(screen.getByRole("status").textContent).toContain(
      "Turn on the AI assistant to see what needs a reply.",
    );
  });
});

describe("HomeDashboard states", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.deadlines = undefined;
  });

  afterEach(cleanup);

  it("busy: one summary line with the count and the next meeting, then the lanes", () => {
    mocks.home.data = {
      ...homeData([
        thread("a", "Quarterly numbers"),
        thread("b", "Lunch on Friday?"),
        thread("c", "Contract"),
      ]),
      waiting: [thread("w", "Intro to Sam")],
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: nextEvent(false),
      },
    };

    renderToday();

    expect(onlyStatus().textContent).toMatch(
      /^3 need a reply · next: Design review \d{1,2}:\d{2}/,
    );
    expect(lanes()).toEqual(["Needs reply", "Waiting on"]);
    expect(screen.queryByText("All clear.")).toBeNull();
  });

  it("says Cue drafted a reply on a row with one waiting", () => {
    mocks.home.data = homeData([
      { ...thread("a", "Quarterly numbers"), cueDrafted: true },
      thread("b", "Dentist"),
    ]);

    renderToday();

    expect(optionFor("a").textContent).toContain("Cue drafted a reply");
    expect(optionFor("b").textContent).not.toContain("Cue drafted a reply");
  });

  it("lists mail from people starred as Important first in Needs reply", async () => {
    const original = mocks.client;
    mocks.client = Object.assign(Object.create(original), {
      capabilities: [
        "method:queryImportantPeople",
        "method:setImportantPerson",
      ],
      queryImportantPeople: async () => [
        { accountId: "account", email: "dana@example.com", addedAtMs: 1 },
      ],
      setImportantPerson: async () => undefined,
    });
    mocks.home.data = homeData([
      thread("a", "Quarterly numbers"),
      { ...thread("b", "Contract"), fromEmail: "Dana@example.com" },
      thread("c", "Lunch on Friday?"),
    ]);

    try {
      renderToday();
      await waitFor(() =>
        expect(
          [...document.querySelectorAll("[data-today-thread]")].map((row) =>
            row.getAttribute("data-today-thread"),
          ),
        ).toEqual(["b", "a", "c"]),
      );
    } finally {
      mocks.client = original;
    }
  });

  it("light: one email that needs a reply, and no empty lanes", () => {
    mocks.home.data = homeData([thread("a", "Quarterly numbers")]);

    renderToday();

    expect(onlyStatus().textContent).toBe("1 needs a reply");
    expect(lanes()).toEqual(["Needs reply"]);
    expect(screen.queryByText(/Nothing here|You're not waiting/)).toBeNull();
  });

  it("caught up: one All clear with proof, what's next, what's due, and who you're waiting on", () => {
    mocks.home.data = {
      ...homeData([]),
      waiting: [
        thread("w1", "Intro to Sam"),
        { ...thread("w2", "Offer letter"), fromEmail: "hr@acme.com" },
      ],
      today: {
        checked: 42,
        filed: 12,
        filedLabel: { labelId: "Label_Newsletter", name: "Newsletter" },
      },
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: nextEvent(false),
      },
      nextUp: [
        {
          id: "canvas:4",
          kind: "deadline",
          title: "Problem set 4",
          at: new Date(Date.now() + 86_400_000).toISOString(),
          source: "Canvas",
          url: "https://school.instructure.com/assignments/4",
        },
      ],
    };

    renderToday();

    const status = onlyStatus();
    expect(status.textContent).toBe(
      "All clear.Nothing needs a reply. Cue checked 42 emails today and filed 12.",
    );
    expect(
      within(status)
        .getByRole("link", { name: "filed 12" })
        .getAttribute("href"),
    ).toBe("/mail/u/0/label/Label_Newsletter");
    expect(screen.getByText(/^Next:/).textContent).toMatch(
      /^Next: Design review \(opens in a new tab\) at \d{1,2}:\d{2}.* · in \d+ (minutes|hours?)$/,
    );
    expect(screen.getByText(/^Due tomorrow:/).textContent).toBe(
      "Due tomorrow: Problem set 4 (opens in a new tab) (Canvas)",
    );
    expect(screen.queryByText(/!/)).toBeNull();
    // Waiting on folds into one collapsed line, and opens in place.
    expect(lanes()).toEqual([]);
    const waiting = screen.getByRole("button", { name: "Waiting on 2 people" });
    expect(waiting.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(waiting);
    expect(lanes()).toEqual(["Waiting on"]);
    expect(screen.getByText("Offer letter")).toBeTruthy();
  });

  it("caught up after 5 pm: says how tomorrow starts", () => {
    mocks.home.data = {
      ...homeData([]),
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: nextEvent(true),
      },
    };

    renderToday();

    expect(screen.getByText(/^Tomorrow starts with/).textContent).toMatch(
      /^Tomorrow starts with Design review \(opens in a new tab\) at \d{1,2}:\d{2}.*\.$/,
    );
    expect(screen.queryByText(/^Next:/)).toBeNull();
  });

  it("caught up on a quiet day: nothing new, and no lines without data", () => {
    mocks.home.data = homeData([]);

    renderToday();

    expect(onlyStatus().textContent).toBe(
      "All clear.Nothing needs a reply. Nothing new today.",
    );
    expect(screen.queryByText(/^Next:|^Due |Waiting on|Connect/)).toBeNull();
  });

  it("caught up with a calendar read in full and empty: says it's clear through tomorrow", () => {
    mocks.home.data = {
      ...homeData([]),
      calendar: { connected: true, clearThroughTomorrow: true, next: null },
    };

    renderToday();

    expect(screen.getByText("Calendar clear through tomorrow.")).toBeTruthy();
  });

  it("caught up but the calendar couldn't be read: doesn't call it clear", () => {
    mocks.home.data = homeData([]);

    renderToday();

    expect(screen.queryByText(/^Calendar clear/)).toBeNull();
    expect(screen.queryByText(/Connect/)).toBeNull();
  });

  it("quiet day: All clear still says how tomorrow starts and which replies Cue drafted", () => {
    mocks.home.data = {
      ...homeData([]),
      waiting: [thread("w1", "Intro to Sam")],
      agentTasks: [
        {
          id: "draft-1",
          kind: "draft",
          threadId: "d1",
          title: "Suggested reply: Lunch on Friday?",
          detail: "Ready for your review",
          at: "2026-10-13T09:00:00.000Z",
        },
      ],
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: nextEvent(true),
      },
    };

    renderToday();

    expect(onlyStatus().textContent).toMatch(/^All clear\./);
    expect(screen.getByText(/^Tomorrow starts with/)).toBeTruthy();
    expect(
      screen.getByRole("heading", { name: /^Drafts ready for you/ }),
    ).toBeTruthy();
    expect(
      screen
        .getByRole("link", { name: /Suggested reply: Lunch on Friday\?/ })
        .getAttribute("href"),
    ).toBe("/mail/u/0/inbox/d1?from=today");
    expect(
      screen.getByRole("button", { name: "Waiting on 1 person" }),
    ).toBeTruthy();
    // Nothing is in a lane, so no empty lane says so.
    expect(lanes()).toEqual([]);
  });

  it("new: says Cue is still reading, not that all is clear", () => {
    const data = homeData([]);
    mocks.home.data = { ...data, cue: { ...data.cue, hasReadMail: false } };

    renderToday();

    expect(onlyStatus().textContent).toBe(
      "Cue is reading your recent mail.What needs a reply will appear here.",
    );
    expect(screen.queryByText("All clear.")).toBeNull();
    expect(lanes()).toEqual([]);
  });

  it("no integrations: offers the calendar and one app the user gets mail from", () => {
    mocks.home.data = {
      ...homeData([]),
      calendar: { connected: false, clearThroughTomorrow: false, next: null },
      suggestion: { app: "canvas", name: "Canvas" },
    };

    renderToday();

    onlyStatus();
    expect(
      screen
        .getByRole("link", { name: "Connect Calendar" })
        .getAttribute("href"),
    ).toBe("/account/calendars");
    expect(screen.getByText(/to see what's next\./)).toBeTruthy();
    expect(
      screen
        .getAllByRole("link", { name: /^Connect / })
        .map((l) => l.textContent),
    ).toEqual(["Connect Calendar", "Connect Canvas"]);
    expect(
      screen.getByRole("link", { name: "Connect Canvas" }).getAttribute("href"),
    ).toBe("/account/integrations");
  });

  it("busy with deadlines: shows Today without them, then adds them to what's next, soonest first", () => {
    const at = (hours: number) =>
      new Date(Date.now() + hours * 3_600_000).toISOString();
    mocks.home.data = {
      ...homeData([thread("a", "Quarterly numbers")]),
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: nextEvent(false),
      },
      nextUp: [
        {
          id: "event:review",
          kind: "event",
          title: "Design review",
          at: at(1),
          source: "Calendar",
          url: "https://calendar.example.com/review",
        },
        {
          id: "event:dinner",
          kind: "event",
          title: "Dinner",
          at: at(30),
          source: "Calendar",
        },
      ],
    };
    const nextUpTitles = () =>
      within(screen.getByRole("region", { name: "Next up" }))
        .getAllByRole("listitem")
        .map((item) =>
          item.textContent?.replace(/^.*?(Design|Dinner|OPS)/, "$1"),
        );

    const { rerender } = renderToday();

    // Today and its meetings show before any connected app answers.
    expect(screen.getByText("Quarterly numbers")).toBeTruthy();
    expect(nextUpTitles()).toEqual([
      "Design reviewCalendar (opens in a new tab)",
      "DinnerCalendar",
    ]);

    mocks.deadlines = [
      {
        id: "jira:OPS-12",
        kind: "deadline",
        title: "OPS-12 Rotate keys",
        at: at(5),
        allDay: true,
        source: "Jira",
      },
    ];
    rerender(
      <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
        <HomeDashboard />
      </ShortcutsProvider>,
    );

    // The meeting is in the list below, so the summary doesn't repeat it.
    expect(onlyStatus().textContent).toBe("1 needs a reply");
    expect(nextUpTitles()).toEqual([
      "Design reviewCalendar (opens in a new tab)",
      "OPS-12 Rotate keysJira",
      "DinnerCalendar",
    ]);
    const nextUp = screen.getByRole("region", { name: "Next up" });
    expect(within(nextUp).getByRole("link").getAttribute("href")).toBe(
      "https://calendar.example.com/review",
    );
  });

  it("still loading needs reply: shows the lanes that loaded, not All clear", () => {
    mocks.home.data = {
      ...homeData([]),
      alsoInInbox: [thread("b", "Dentist")],
      pending: ["needsYou"],
    };

    renderToday();

    expect(screen.queryByText("All clear.")).toBeNull();
    expect(screen.queryByText("Couldn't load this")).toBeNull();
    expect(screen.queryAllByRole("status")).toEqual([]);
    expect(lanes()).toEqual(["Also in your inbox"]);
  });

  it("caught up while waiting-on is still loading: shows it loading, not missing", () => {
    mocks.home.data = { ...homeData([]), pending: ["waiting"] };

    renderToday();

    expect(onlyStatus().textContent).toMatch(/^All clear\./);
    expect(skeletons()).not.toEqual([]);
  });

  it("gave up on a pending lane: offers to try again instead of loading forever", () => {
    mocks.home.data = {
      ...homeData([thread("a", "Quarterly numbers")]),
      pending: ["alsoInInbox"],
    };
    mocks.home.gaveUp = true;

    renderToday();

    expect(lanes()).toEqual(["Needs reply"]);
    expect(skeletons()).toEqual([]);
    expect(screen.getByText("Couldn't load this")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(mocks.home.retry).toHaveBeenCalled();
  });

  it("needs reply failed to load: never claims nothing needs a reply", () => {
    mocks.home.data = {
      ...homeData([]),
      alsoInInbox: [thread("b", "Dentist")],
      failed: ["needsYou"],
    };

    renderToday();

    expect(screen.queryByText("All clear.")).toBeNull();
    expect(screen.queryAllByRole("status")).toEqual([]);
    expect(lanes()).toEqual(["Also in your inbox"]);
    expect(screen.getByText("Couldn't load this")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /try again/i }));
    expect(mocks.home.retry).toHaveBeenCalled();
  });

  it("error: shows the error alone, with no status or lanes", () => {
    mocks.home.data = undefined;
    mocks.home.error = { error: "Boom" };

    renderToday();

    expect(screen.getByText("Couldn't load this")).toBeTruthy();
    expect(screen.queryAllByRole("status")).toEqual([]);
    expect(lanes()).toEqual([]);
  });

  it("refresh deferred: keeps the lanes on screen instead of the error", () => {
    mocks.home.data = homeData([thread("a", "Quarterly numbers")]);
    mocks.home.error = {
      error: "Gmail is busy for this account. Try again shortly.",
      status: 503,
    };

    renderToday();

    expect(lanes()).toEqual(["Needs reply"]);
    expect(screen.queryByText("Couldn't load this")).toBeNull();
  });
});

describe("HomeDashboard Your day", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
  });

  afterEach(() => {
    cleanup();
    mocks.day = { events: [], more: 0 };
  });

  it("busy with meetings today: the strip lists them and Next up keeps only what it doesn't", () => {
    const review = new Date(Date.now() + 3_600_000).toISOString();
    mocks.day = day([dayMeeting("review", "Design review", review)]);
    mocks.home.data = {
      ...homeData([thread("a", "Quarterly numbers")]),
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: {
          id: "review",
          title: "Design review",
          at: review,
          url: undefined,
          tomorrow: false,
        },
      },
      nextUp: [
        {
          id: "event:review",
          kind: "event",
          title: "Design review",
          at: review,
          source: "Calendar",
        },
        {
          id: "jira:OPS-12",
          kind: "deadline",
          title: "OPS-12 Rotate keys",
          at: new Date(Date.now() + 2 * 86_400_000).toISOString(),
          allDay: true,
          source: "Jira",
        },
      ],
    };

    renderToday();

    const strip = screen.getByRole("region", { name: "Your day" });
    expect(within(strip).getByText("Design review")).toBeTruthy();
    // Said once: not again in Next up or the summary.
    expect(screen.getAllByText(/Design review/)).toHaveLength(1);
    expect(onlyStatus().textContent).toBe("1 needs a reply");
    const nextUp = screen.getByRole("region", { name: "Next up" });
    expect(within(nextUp).getByText("OPS-12 Rotate keys")).toBeTruthy();
  });

  it("all clear with a meeting today: the strip names it instead of the Next line", () => {
    const review = new Date(Date.now() + 45 * 60_000).toISOString();
    mocks.day = day([dayMeeting("review", "Design review", review)]);
    mocks.home.data = {
      ...homeData([]),
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: {
          id: "review",
          title: "Design review",
          at: review,
          url: undefined,
          tomorrow: false,
        },
      },
    };

    renderToday();

    expect(onlyStatus().textContent).toContain("All clear.");
    expect(screen.getByRole("region", { name: "Your day" })).toBeTruthy();
    expect(screen.queryByText(/^Next:/)).toBeNull();
  });

  it("a different meeting with the same name and time stays in Next up", () => {
    const at = new Date(Date.now() + 3_600_000).toISOString();
    mocks.day = day([dayMeeting("team-sync", "Sync", at)]);
    mocks.home.data = {
      ...homeData([thread("a", "Quarterly numbers")]),
      nextUp: [
        {
          id: "event:client-sync",
          kind: "event",
          title: "Sync",
          at,
          source: "Calendar",
        },
      ],
    };

    renderToday();

    const nextUp = screen.getByRole("region", { name: "Next up" });
    expect(within(nextUp).getByText("Sync")).toBeTruthy();
    expect(
      within(screen.getByRole("region", { name: "Your day" })).getByText(
        "Sync",
      ),
    ).toBeTruthy();
  });

  it("while today's meetings load, holds them back rather than move them when they land", () => {
    mocks.day = undefined;
    const soon = new Date(Date.now() + 60_000).toISOString();
    mocks.home.data = {
      ...homeData([]),
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: {
          id: "review",
          title: "Design review",
          at: soon,
          url: undefined,
          tomorrow: false,
        },
      },
    };

    renderToday();

    expect(onlyStatus().textContent).toContain("All clear.");
    expect(screen.queryByText(/^Next:/)).toBeNull();
    expect(screen.queryByRole("region", { name: "Your day" })).toBeNull();
  });

  it("no meetings today: no strip, and the clear line still says so", () => {
    mocks.day = day([]);
    mocks.home.data = {
      ...homeData([]),
      calendar: { connected: true, clearThroughTomorrow: true, next: null },
    };

    renderToday();

    expect(screen.queryByRole("region", { name: "Your day" })).toBeNull();
    expect(screen.getByText("Calendar clear through tomorrow.")).toBeTruthy();
  });

  it("no calendar connected: no strip", () => {
    mocks.day = { events: [], more: 0 };
    mocks.home.data = {
      ...homeData([]),
      calendar: { connected: false, clearThroughTomorrow: false, next: null },
    };

    renderToday();

    expect(screen.queryByRole("region", { name: "Your day" })).toBeNull();
    expect(screen.getByRole("link", { name: "Connect Calendar" })).toBeTruthy();
  });
});

describe("HomeDashboard Didn't send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.bounces = [
      {
        accountId: "account",
        conversationId: "sent",
        messageId: "sent-bounce",
        subject: "Delivery Status Notification (Failure)",
        sentSubject: "Contract draft",
        receivedAtMs: Date.now(),
      },
    ];
  });

  afterEach(() => {
    cleanup();
    mocks.bounces = [];
    mocks.dismissedBounces = [];
  });

  it("adds a card first and leaves the bounced conversation's rows where they are", () => {
    mocks.home.data = {
      ...homeData([thread("a", "Quarterly numbers")]),
      waiting: [thread("sent", "Contract draft"), thread("w", "Intro to Sam")],
      alsoInInbox: [thread("sent", "Contract draft"), thread("b", "Dentist")],
    };

    renderToday();

    const card = within(
      screen.getByRole("list", { name: "Didn't send" }),
    ).getByRole("listitem");
    expect(within(card).getByText("Contract draft")).toBeTruthy();
    expect(
      within(card).getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/mail/u/0/inbox/sent?from=today");
    // A bounce's From isn't authenticated: it never hides or moves a row.
    expect(within(lane("Waiting on")).getByText("Contract draft")).toBeTruthy();
    expect(
      within(lane("Also in your inbox")).getByText("Contract draft"),
    ).toBeTruthy();
  });

  it("never removes a Waiting on or Waiting on you row, even a forged bounce threaded after a real reply", () => {
    // A postmaster@ message anyone could send, threaded into two
    // conversations after their real replies.
    mocks.bounces = [
      {
        accountId: "account",
        conversationId: "asked",
        messageId: "forged-1",
        subject: "Undeliverable",
        sentSubject: "Lunch on Friday?",
        receivedAtMs: Date.now(),
      },
      {
        accountId: "account",
        conversationId: "w",
        messageId: "forged-2",
        subject: "Undeliverable",
        sentSubject: "Intro to Sam",
        receivedAtMs: Date.now(),
      },
    ];
    mocks.waitingOnYou = [thread("asked", "Lunch on Friday?")];
    mocks.home.data = {
      ...homeData([]),
      cue: { aiAccess: true, replyTracking: true, hasReadMail: false },
      waiting: [thread("w", "Intro to Sam")],
    };

    try {
      renderToday();

      expect(
        within(screen.getByRole("list", { name: "Didn't send" })).getAllByRole(
          "listitem",
        ),
      ).toHaveLength(2);
      expect(
        within(lane("Waiting on you")).getByText("Lunch on Friday?"),
      ).toBeTruthy();
      expect(within(lane("Waiting on")).getByText("Intro to Sam")).toBeTruthy();
    } finally {
      mocks.waitingOnYou = [];
    }
  });

  it("opens in the bounce's own account across accounts", () => {
    mocks.searchParams = new URLSearchParams({ accounts: "all" });
    mocks.emailAccounts = [
      emailAccount("account", "ada@example.com"),
      emailAccount("account-b", "ada@work.example"),
    ];
    mocks.homes = {
      account: homeData([]),
      "account-b": homeData([]),
    };
    mocks.bounces = [{ ...mocks.bounces[0], accountId: "account-b" }];

    try {
      renderToday();

      const card = within(
        screen.getByRole("list", { name: "Didn't send" }),
      ).getByRole("listitem");
      expect(
        within(card).getByRole("link", { name: "Open" }).getAttribute("href"),
      ).toBe("/mail/u/0/all-inboxes/inbox/sent?account=1&from=today");
      expect(
        within(card).getByRole("img", { name: "Account: ada@work.example" }),
      ).toBeTruthy();
    } finally {
      mocks.searchParams = new URLSearchParams();
      mocks.emailAccounts = [];
      mocks.homes = {};
    }
  });
});

describe("HomeDashboard Waiting on you", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.waitingOnYou = [thread("asked", "Lunch on Friday?")];
  });

  afterEach(() => {
    cleanup();
    mocks.waitingOnYou = [];
  });

  it("new mailbox: lists local mail that may need a reply while Cue reads, each conversation once", () => {
    mocks.home.data = {
      ...homeData([]),
      cue: { aiAccess: true, replyTracking: true, hasReadMail: false },
      alsoInInbox: [
        thread("asked", "Lunch on Friday?"),
        thread("b", "Dentist"),
      ],
    };

    renderToday();

    expect(onlyStatus().textContent).toContain("Cue is reading");
    expect(lanes()).toEqual(["Waiting on you", "Also in your inbox"]);
    expect(screen.getByText("From your mail, not checked by AI")).toBeTruthy();
    expect(optionFor("asked").textContent).toContain("May need a reply");
    expect(
      within(lane("Also in your inbox")).queryByText("Lunch on Friday?"),
    ).toBeNull();
  });

  it("leaves a mailbox Cue has read to Cue, even when nothing needs a reply", () => {
    mocks.home.data = homeData([]);

    renderToday();

    expect(onlyStatus().textContent).toContain("All clear.");
    expect(lanes()).not.toContain("Waiting on you");
  });

  it("hides once Needs reply has conversations of its own", () => {
    mocks.home.data = unread(homeData([thread("a", "Quarterly numbers")]));

    renderToday();

    expect(lanes()).toEqual(["Needs reply"]);
  });

  it("stays while Needs reply loads, which has nothing for a mailbox Cue hasn't read", () => {
    mocks.home.data = { ...unread(homeData([])), pending: ["needsYou"] };

    renderToday();

    expect(lanes()).toEqual(["Waiting on you"]);
  });

  it("sits above Cue's notice, where it showed before Today answered", () => {
    mocks.home.data = unread(homeData([]));

    renderToday();

    const group = lane("Waiting on you");
    expect(
      group.compareDocumentPosition(onlyStatus()) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("reports how many rows first showed, and nothing about them", () => {
    mocks.home.data = unread(homeData([]));
    mocks.waitingOnYou = [
      thread("asked", "Lunch on Friday?"),
      thread("b", "Dentist"),
    ];

    renderToday();

    expect(mocks.reportActivation).toHaveBeenCalledWith(
      "account",
      "first_waiting_on_you_item",
      { itemCount: 2, msSinceTodayOpened: expect.any(Number) },
    );
  });

  describe("before Today answers", () => {
    beforeEach(() => {
      mocks.home.isLoading = true;
      mocks.home.data = undefined;
    });

    afterEach(() => {
      mocks.home.isLoading = false;
      mocks.homeCue = undefined;
    });

    it("shows from local mail for a mailbox Cue hasn't read", () => {
      mocks.homeCue = { account: false };

      renderToday();

      expect(lanes()[0]).toBe("Waiting on you");
      expect(optionFor("asked").textContent).toContain("May need a reply");
      // The rest of Today still loads below it.
      expect(skeletons()).not.toEqual([]);
      expect(mocks.reportActivation).toHaveBeenCalledWith(
        "account",
        "first_waiting_on_you_item",
        { itemCount: 1, msSinceTodayOpened: expect.any(Number) },
      );
    });

    it("waits for the answer for a mailbox Cue has read, which leaves it to Cue", () => {
      mocks.homeCue = { account: true };

      renderToday();

      expect(lanes()).not.toContain("Waiting on you");
      expect(mocks.reportActivation).not.toHaveBeenCalled();
    });

    it("waits while it isn't known whether Cue has read the mailbox", () => {
      renderToday();

      expect(lanes()).not.toContain("Waiting on you");
    });
  });

  it("dismisses a conversation", () => {
    mocks.home.data = unread(homeData([]));

    renderToday();
    fireEvent.click(
      within(rowFor("asked")).getAllByRole("button", { name: "Dismiss" })[0],
    );

    expect(mocks.dismissWaitingOnYou).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: "asked" }),
    );
  });
});

describe("HomeDashboard before the server answers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.submitConversations.mockResolvedValue({ status: "queued" });
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.isLoading = true;
    mocks.home.data = undefined;
    mocks.localInboxArgs = [];
    mocks.localInbox = [
      localConversation("local-1", "Dentist on Tuesday"),
      localConversation("local-2", "Invoice for October"),
    ];
  });

  afterEach(() => {
    cleanup();
    mocks.home.isLoading = false;
    mocks.localInbox = null;
  });

  it("first visit: shows the inbox from local mail while Cue's lanes load", () => {
    renderToday();

    expect(lanes()).toEqual(["Also in your inbox"]);
    expect(
      within(lane("Also in your inbox")).getByText("Dentist on Tuesday"),
    ).toBeTruthy();
    // Cue's own lanes still load; nothing claims all is clear.
    expect(skeletons()).not.toEqual([]);
    expect(screen.queryByText("All clear.")).toBeNull();
    // Whether Cue is on isn't known yet, so it offers no Needs reply.
    expect(screen.queryByRole("button", { name: "Needs reply" })).toBeNull();
    expect(mocks.localInboxArgs.at(-1)).toMatchObject({
      accounts: [{ id: "account", email: "ada@example.com" }],
      named: false,
      enabled: true,
    });
  });

  it("first visit: archives a local row through the mail engine", async () => {
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("local-1")).getAllByRole("button", {
          name: "Archive conversation",
        })[0],
      );
    });

    expect(screen.queryByText("Dentist on Tuesday")).toBeNull();
    expect(mocks.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: [{ accountId: "account", conversationId: "local-1" }],
        change: { kind: "archive" },
      }),
    );
  });

  it("server's inbox still loading: shows local rows, each conversation once", () => {
    mocks.home.isLoading = false;
    mocks.home.data = {
      ...homeData([thread("local-1", "Dentist on Tuesday")]),
      pending: ["alsoInInbox"],
    };

    renderToday();

    expect(lanes()).toEqual(["Needs reply", "Also in your inbox"]);
    const inbox = lane("Also in your inbox");
    expect(within(inbox).queryByText("Dentist on Tuesday")).toBeNull();
    expect(within(inbox).getByText("Invoice for October")).toBeTruthy();
    expect(skeletons()).toEqual([]);
  });

  it("server's inbox still loading: leaves out mail Cue filed, as the server does", () => {
    mocks.home.isLoading = false;
    mocks.home.data = {
      ...homeData([]),
      pending: ["alsoInInbox"],
      handledLabelIds: ["Label_Newsletter"],
    };
    mocks.localInbox = [
      localConversation("weekly", "This week in design", ["Label_Newsletter"]),
      localConversation("local-2", "Invoice for October"),
    ];

    renderToday();

    const inbox = lane("Also in your inbox");
    expect(within(inbox).queryByText("This week in design")).toBeNull();
    expect(within(inbox).getByText("Invoice for October")).toBeTruthy();
  });

  it("server's inbox loaded: shows its rows, not the local ones", () => {
    mocks.home.isLoading = false;
    mocks.home.data = {
      ...homeData([]),
      alsoInInbox: [thread("server-1", "Board minutes")],
    };

    renderToday();

    const inbox = lane("Also in your inbox");
    expect(within(inbox).getByText("Board minutes")).toBeTruthy();
    expect(within(inbox).queryByText("Invoice for October")).toBeNull();
    expect(mocks.localInboxArgs.at(-1)?.enabled).toBe(false);
  });

  it("no local mail yet: keeps the placeholders until the server answers", () => {
    mocks.localInbox = null;

    renderToday();

    expect(lanes()).toEqual([]);
    expect(skeletons()).not.toEqual([]);
  });
});

describe("HomeDashboard on a copy from an earlier day", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    window.localStorage.clear();
    resetBrowserCacheForTesting("user");
  });

  afterEach(cleanup);

  it("shows yesterday's conversations, not yesterday's All clear or counts", () => {
    mocks.home.data = savedYesterday();

    renderToday();

    expect(onlyStatus().textContent).toBe("Updating…");
    expect(lanes()).toEqual(["Also in your inbox"]);
    expect(screen.queryByText("All clear.")).toBeNull();
    expect(screen.queryByText(/Nothing new today|Cue checked/)).toBeNull();
    expect(screen.queryByText(/Design review/)).toBeNull();
  });

  it("says when the refresh didn't land, rather than updating forever", () => {
    mocks.home.data = savedYesterday();
    mocks.home.error = { error: "Failed to fetch" };

    renderToday();

    expect(onlyStatus().textContent).toBe(
      "Couldn't refresh. Showing what Today had earlier.",
    );
    expect(lanes()).toEqual(["Also in your inbox"]);
  });

  it("marks rows a given-up refresh couldn't replace as possibly out of date", () => {
    mocks.home.data = {
      ...homeData([thread("a", "Quarterly numbers")]),
      waiting: [thread("w", "Intro to Sam")],
      stale: ["waiting"],
    } as GetHomeResponse;
    mocks.home.gaveUp = true;

    renderToday();

    const waiting = screen.getByRole("region", { name: "Waiting on" });
    expect(within(waiting).getByText("May be out of date")).toBeTruthy();
    const needsReply = screen.getByRole("region", { name: "Needs reply" });
    expect(within(needsReply).queryByText("May be out of date")).toBeNull();
  });
});

describe("HomeDashboard across accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.client.submitConversations.mockResolvedValue({ status: "queued" });
    mocks.client.cancelOperation.mockResolvedValue({ status: "cancelled" });
    mocks.undoLatestToast.mockResolvedValue(false);
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.data = undefined;
    mocks.searchParams = new URLSearchParams("accounts=all");
    mocks.emailAccounts = [
      emailAccount("account", "a@example.com"),
      emailAccount("account-b", "b@example.com"),
    ];
    mocks.homes = {
      account: homeData([thread("a1", "Quarterly numbers")]),
      "account-b": homeData([thread("b1", "Lunch on Friday?")]),
    };
  });

  afterEach(() => {
    cleanup();
    mocks.searchParams = new URLSearchParams();
    mocks.emailAccounts = [];
    mocks.homes = {};
  });

  it("offers Catch up on every included account's inbox", () => {
    mocks.catchUpProps = [];
    renderToday();

    expect(mocks.catchUpProps.at(-1)).toMatchObject({
      query: { type: "inbox" },
      allInboxes: {
        accounts: [
          { id: "account", email: "a@example.com" },
          { id: "account-b", email: "b@example.com" },
        ],
      },
    });
  });

  it("hides a caught-up card's copies in other accounts, and replies in its own account", () => {
    mocks.catchUpProps = [];
    renderToday();
    const props = latestCatchUpProps();

    act(() => props.onRemoved(caughtUpCard(), []));
    expect(screen.queryByText("Quarterly numbers")).toBeNull();
    expect(screen.queryByText("Lunch on Friday?")).toBeNull();

    act(() => props.onReply(caughtUpCard()));
    expect(mocks.push).toHaveBeenCalledWith(
      "/mail/u/0/all-inboxes/inbox/a1?account=0&from=today&reply=1",
    );
  });

  it("keeps a copy's row where its account refused the change", () => {
    mocks.catchUpProps = [];
    renderToday();

    act(() => latestCatchUpProps().onRemoved(caughtUpCard(), ["account-b"]));

    expect(screen.queryByText("Quarterly numbers")).toBeNull();
    expect(screen.getByText("Lunch on Friday?")).toBeTruthy();
  });

  it("brings back a caught-up card's copies when its undo restores it", async () => {
    mocks.catchUpProps = [];
    render(
      <StrictMode>
        <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
          <HomeDashboard />
        </ShortcutsProvider>
      </StrictMode>,
    );
    const { actions, onRemoved } = latestCatchUpProps();
    const card = caughtUpCard();

    await act(async () => {
      actions.addTargets([
        {
          id: card.threadId,
          account: { id: card.accountId },
          messageIds: ["a1-message"],
          inInbox: true,
          copies: card.copies,
        },
      ]);
      await actions.changeCard([card.key], { kind: "archive" });
      onRemoved(card, []);
    });
    expect(screen.queryByText("Quarterly numbers")).toBeNull();
    expect(screen.queryByText("Lunch on Friday?")).toBeNull();

    // With another change to Today still pending, React works out the
    // restore during render, where Strict Mode runs it twice.
    await act(async () => {
      onRemoved({ ...caughtUpCard(), key: "account:other", copies: [] }, []);
      await actions.undo();
    });

    expect(screen.getByText("Quarterly numbers")).toBeTruthy();
    expect(screen.getByText("Lunch on Friday?")).toBeTruthy();
  });

  it("reads every account's local inbox, each row naming its account", () => {
    mocks.localInboxArgs = [];
    renderToday();

    expect(mocks.localInboxArgs.at(-1)).toMatchObject({
      accounts: [
        { id: "account", email: "a@example.com" },
        { id: "account-b", email: "b@example.com" },
      ],
      named: true,
    });
  });

  it("shows both accounts' rows in one lane, each naming its account", () => {
    renderToday();

    expect(within(lane("Needs reply")).getAllByRole("option")).toHaveLength(2);
    expect(
      within(rowFor("account-b:b1")).getByRole("img", {
        name: "Inbox: b@example.com",
      }),
    ).toBeTruthy();
    expect(
      within(rowFor("account:a1")).getByRole("img", {
        name: "Inbox: a@example.com",
      }),
    ).toBeTruthy();
    expect(onlyStatus().textContent).toBe("2 need a reply");
  });

  it("archives the second account's row in that account, and undo brings it back", async () => {
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("account-b:b1")).getAllByRole("button", {
          name: "Archive conversation",
        })[0],
      );
    });

    expect(screen.queryByText("Lunch on Friday?")).toBeNull();
    expect(mocks.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        accountId: "account-b",
        conversations: [{ accountId: "account-b", conversationId: "b1" }],
        change: { kind: "archive" },
      }),
    );

    const [{ onUndo }] = mocks.toastUndo.mock.calls[0];
    await act(async () => onUndo());
    expect(screen.getByText("Lunch on Friday?")).toBeTruthy();
    expect(mocks.client.cancelOperation).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "account-b" }),
    );
  });

  it("tells the row's own account that no reply is needed", async () => {
    renderToday();

    await act(async () => {
      fireEvent.click(
        within(rowFor("account-b:b1")).getAllByRole("button", {
          name: "No reply needed",
        })[0],
      );
    });

    expect(mocks.markNoReplyNeeded).toHaveBeenCalledWith("account-b", {
      threadId: "b1",
    });
    expect(
      within(lane("Also in your inbox")).getByText("Lunch on Friday?"),
    ).toBeTruthy();
  });

  it("opens a row in All inboxes, in its account, returning to Today", () => {
    renderToday();

    fireEvent.click(
      within(rowFor("account-b:b1")).getAllByRole("button", {
        name: "Reply to conversation",
      })[0],
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/mail/u/0/all-inboxes/inbox/b1?account=1&from=today&reply=1",
    );
  });

  it("nudges a Waiting on row in its own account", () => {
    mocks.homes["account-b"] = {
      ...homeData([]),
      waiting: [thread("b-sent", "Contract draft")],
    };
    renderToday();

    fireEvent.click(
      within(rowFor("account-b:b-sent")).getAllByRole("button", {
        name: NUDGE,
      })[0],
    );

    expect(mocks.push).toHaveBeenCalledWith(
      "/mail/u/0/all-inboxes/inbox/b-sent?account=1&from=today&reply=1",
    );
  });

  it("names an account whose lane failed, and never says all is clear", () => {
    mocks.homes = {
      account: homeData([]),
      "account-b": { ...homeData([]), failed: ["needsYou"] },
    };

    renderToday();

    expect(screen.queryByText("All clear.")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "b@example.com couldn't be loaded",
    );
  });

  it("shows a conversation in both mailboxes once, saying where else it is", () => {
    mocks.homes = {
      account: {
        ...homeData([]),
        alsoInInbox: [
          { ...thread("a1", "Contract"), rfcMessageId: "<same@mail>" },
        ],
      },
      "account-b": homeData([
        { ...thread("b1", "Contract"), rfcMessageId: "<same@mail>" },
      ]),
    };

    renderToday();

    expect(screen.getAllByText("Contract")).toHaveLength(1);
    expect(
      within(rowFor("account-b:b1")).getByText("Also in a@example.com"),
    ).toBeTruthy();
  });

  it("before the server's inbox loads, leaves out a local copy of mail already in Needs reply", () => {
    mocks.homes = {
      account: { ...homeData([]), pending: ["alsoInInbox"] },
      "account-b": {
        ...homeData([
          { ...thread("b1", "Contract"), rfcMessageId: "<same@mail>" },
        ]),
        pending: ["alsoInInbox"],
      },
    };
    mocks.localInbox = [
      {
        ...localConversation("a-copy", "Contract"),
        latestInternetMessageId: "<same@mail>",
      },
      localConversation("local-2", "Invoice for October"),
    ];

    try {
      renderToday();

      expect(screen.getAllByText("Contract")).toHaveLength(1);
      const inbox = lane("Also in your inbox");
      expect(within(inbox).getByText("Invoice for October")).toBeTruthy();
    } finally {
      mocks.localInbox = null;
    }
  });

  it("shows Today loading while the account list loads, not an empty page", () => {
    mocks.emailAccounts = undefined;

    renderToday();

    expect(skeletons()).not.toEqual([]);
    expect(screen.queryByText("All clear.")).toBeNull();
  });

  it("names the account of each draft ready for review", () => {
    mocks.homes = {
      account: homeData([]),
      "account-b": {
        ...homeData([]),
        agentTasks: [
          {
            id: "draft-b",
            kind: "draft",
            threadId: "b1",
            title: "Suggested reply: Lunch on Friday?",
            detail: "Ready for your review",
            at: "2026-10-13T09:00:00.000Z",
          },
        ],
      },
    };

    renderToday();

    const draft = screen.getByRole("link", {
      name: /Suggested reply: Lunch on Friday\?/,
    });
    expect(
      within(draft).getByRole("img", { name: "Inbox: b@example.com" }),
    ).toBeTruthy();
    expect(draft.getAttribute("href")).toBe(
      "/mail/u/0/all-inboxes/inbox/b1?account=1&from=today",
    );
  });

  describe("Waiting on you", () => {
    const A = { id: "account", email: "a@example.com" };
    const B = { id: "account-b", email: "b@example.com" };

    beforeEach(() => {
      mocks.waitingOnYou = [
        { ...thread("b-ask", "Ski trip"), account: B },
        { ...thread("a-ask", "Dentist"), account: A },
      ];
    });

    afterEach(() => {
      mocks.waitingOnYou = [];
      mocks.homeCue = undefined;
      mocks.home.isLoading = false;
    });

    it("shows a new mailbox's rows before any account answers, and not one Cue has read", () => {
      mocks.home.isLoading = true;
      mocks.homes = { account: undefined, "account-b": undefined };
      mocks.homeCue = { account: true, "account-b": false };

      renderToday();

      expect(lanes()[0]).toBe("Waiting on you");
      expect(rowFor("account-b:b-ask")).toBeTruthy();
      expect(screen.queryByText("Dentist")).toBeNull();
      expect(skeletons()).not.toEqual([]);
    });

    it("waits for an account whose state isn't known yet", () => {
      mocks.home.isLoading = true;
      mocks.homes = { account: undefined, "account-b": undefined };
      mocks.homeCue = { account: true };

      renderToday();

      expect(lanes()).not.toContain("Waiting on you");
    });

    it("stays first while another account's Needs reply loads, and when it lands", () => {
      mocks.homes = {
        account: { ...homeData([]), pending: ["needsYou"] },
        "account-b": unread(homeData([])),
      };

      const view = renderToday();
      expect(lanes()[0]).toBe("Waiting on you");
      expect(rowFor("account-b:b-ask")).toBeTruthy();

      mocks.homes = {
        account: homeData([thread("a1", "Quarterly numbers")]),
        "account-b": unread(homeData([])),
      };
      view.unmount();
      renderToday();

      expect(lanes().slice(0, 2)).toEqual(["Waiting on you", "Needs reply"]);
      expect(rowFor("account-b:b-ask")).toBeTruthy();
      expect(screen.queryByText("Dentist")).toBeNull();
    });

    it("leaves out a copy of mail another account lists in Needs reply past the merged cap", () => {
      const many = Array.from({ length: 12 }, (_, index) =>
        thread(`a${index}`, `Request ${index}`),
      );
      mocks.waitingOnYou = [
        {
          ...thread("b-ask", "Contract"),
          rfcMessageId: "same@mail",
          account: B,
        },
      ];
      mocks.homes = {
        // Its last row is past what Today's merged lane lists.
        account: homeData([
          ...many,
          {
            ...thread("a-contract", "Contract"),
            at: "2026-10-01T09:00:00.000Z",
            priority: "low",
            // Normalised where its header is read, as the store keys it.
            rfcMessageId: "same@mail",
          },
        ]),
        "account-b": unread(homeData([])),
      };

      renderToday();

      expect(screen.queryByText("Contract")).toBeNull();
    });

    it("leaves out a copy of mail another account lists in Needs reply, and in the inbox below", () => {
      mocks.waitingOnYou = [
        {
          ...thread("b-ask", "Contract"),
          rfcMessageId: "same@mail",
          account: B,
        },
        {
          ...thread("b-lunch", "Lunch"),
          rfcMessageId: "lunch@mail",
          account: B,
        },
      ];
      mocks.homes = {
        account: {
          ...homeData([
            { ...thread("a1", "Contract"), rfcMessageId: "same@mail" },
          ]),
          alsoInInbox: [
            { ...thread("a-lunch", "Lunch"), rfcMessageId: "lunch@mail" },
          ],
        },
        "account-b": unread(homeData([])),
      };

      renderToday();

      expect(screen.getAllByText("Contract")).toHaveLength(1);
      expect(within(lane("Needs reply")).getByText("Contract")).toBeTruthy();
      expect(screen.getAllByText("Lunch")).toHaveLength(1);
      expect(within(lane("Waiting on you")).getByText("Lunch")).toBeTruthy();
    });
  });

  it("is one account's Today with one account in All inboxes", () => {
    mocks.emailAccounts = [emailAccount("account", "a@example.com")];
    mocks.home.data = homeData([thread("a1", "Quarterly numbers")]);

    renderToday();

    expect(rowFor("a1")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Inbox:/ })).toBeNull();
  });
});

describe("HomeDashboard Reading", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.client.submitConversations.mockResolvedValue({ status: "queued" });
    mocks.client.cancelOperation.mockResolvedValue({ status: "cancelled" });
    mocks.undoLatestToast.mockResolvedValue(false);
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.data = {
      ...homeData([thread("first", "Quarterly numbers")]),
      reading: [
        newsletter("n1", "Field Notes", "Slow travel"),
        newsletter("n2", "Morning Brew", "Markets"),
        newsletter("n3", "Field Notes", "Trains"),
      ],
    };
  });

  afterEach(cleanup);

  it("bundles newsletters into one row naming who they're from, which opens in place", () => {
    renderToday();

    const toggle = screen.getByRole("button", {
      name: "From Field Notes and Morning Brew",
    });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText("Slow travel")).toBeNull();
    expect(lanes()).not.toContain("Reading");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(within(lane("Reading")).getAllByRole("option")).toHaveLength(3);
    // The newsletters stay out of the other lanes.
    expect(within(lane("Needs reply")).getAllByRole("option")).toHaveLength(1);
  });

  it("marks the whole bundle read through the mail engine", async () => {
    renderToday();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Mark all read" }));
    });

    expect(mocks.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: ["n1", "n2", "n3"].map((conversationId) => ({
          accountId: "account",
          conversationId,
        })),
        change: { kind: "set_read", read: true },
      }),
    );
    expect(screen.queryByRole("heading", { name: /Reading/ })).toBeNull();
  });

  it("archives the whole bundle, and undo brings it back", async () => {
    renderToday();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
    });

    expect(mocks.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: ["n1", "n2", "n3"].map((conversationId) => ({
          accountId: "account",
          conversationId,
        })),
        change: { kind: "archive" },
      }),
    );
    expect(
      screen.queryByRole("button", { name: /^From Field Notes/ }),
    ).toBeNull();

    const [{ message, onUndo }] = mocks.toastUndo.mock.calls[0];
    expect(message).toBe("Archived 3 conversations");
    await act(async () => onUndo());

    expect(
      screen.getByRole("button", { name: "From Field Notes and Morning Brew" }),
    ).toBeTruthy();
  });

  it("keeps the bundle when the engine refuses the change", async () => {
    mocks.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    renderToday();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
    });

    expect(
      screen.getByRole("button", { name: "From Field Notes and Morning Brew" }),
    ).toBeTruthy();
  });
});

describe("HomeDashboard Reading across accounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.client.submitConversations.mockResolvedValue({ status: "queued" });
    mocks.undoLatestToast.mockResolvedValue(false);
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.data = undefined;
    mocks.searchParams = new URLSearchParams("accounts=all");
    mocks.emailAccounts = [
      emailAccount("account", "a@example.com"),
      emailAccount("account-b", "b@example.com"),
    ];
    mocks.homes = {
      account: {
        ...homeData([]),
        reading: [newsletter("a-n", "Field Notes", "Slow travel")],
      },
      "account-b": {
        ...homeData([]),
        reading: [newsletter("b-n", "Morning Brew", "Markets")],
      },
    };
  });

  afterEach(() => {
    cleanup();
    mocks.searchParams = new URLSearchParams();
    mocks.emailAccounts = [];
    mocks.homes = {};
  });

  it("bundles every account's newsletters and archives each in its own account", async () => {
    renderToday();

    fireEvent.click(
      screen.getByRole("button", { name: "From Field Notes and Morning Brew" }),
    );
    expect(within(lane("Reading")).getAllByRole("option")).toHaveLength(2);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Archive all" }));
    });

    for (const [accountId, conversationId] of [
      ["account", "a-n"],
      ["account-b", "b-n"],
    ]) {
      expect(mocks.client.submitConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId,
          conversations: [{ accountId, conversationId }],
          change: { kind: "archive" },
        }),
      );
    }
  });
});

describe("HomeDashboard greeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.home.error = undefined;
    mocks.home.gaveUp = false;
    mocks.home.data = homeData([]);
  });

  afterEach(() => {
    cleanup();
    mocks.emailAccounts = [];
  });

  it("greets the user by their own name, not the open mailbox's", async () => {
    mocks.emailAccounts = [
      {
        ...emailAccount("account", "support@acme.example"),
        name: "Acme Support",
        user: { name: "Grace Hopper", email: "grace@example.com" },
      },
    ];

    renderToday();

    await waitFor(() => expect(greeting()).toMatch(/^Good \w+, Grace$/));
  });

  it("uses the name on the user's own mailbox when the profile has none", async () => {
    const user = { name: "", email: "grace@example.com" };
    mocks.emailAccounts = [
      { ...emailAccount("work", "support@acme.example"), name: "Acme", user },
      {
        ...emailAccount("account", "grace@example.com"),
        name: "Grace Hopper",
        user,
      },
    ];

    renderToday();

    await waitFor(() => expect(greeting()).toMatch(/^Good \w+, Grace$/));
  });

  it("greets without a name rather than with an address", async () => {
    const user = { name: "", email: "grace@example.com" };
    mocks.emailAccounts = [
      {
        ...emailAccount("account", "grace@example.com"),
        name: "grace@example.com",
        user,
      },
    ];

    renderToday();

    await waitFor(() => expect(greeting()).toMatch(/^Good \w+$/));
  });
});

function greeting() {
  return screen.getByRole("heading", { level: 1 }).textContent;
}

function emailAccount(id: string, email: string) {
  return {
    id,
    email,
    name: null,
    image: null,
    includeInAllAccounts: true,
    account: { disconnectedAt: null, provider: "google" },
  };
}

function onlyStatus() {
  const statuses = screen.getAllByRole("status");
  expect(statuses).toHaveLength(1);
  return statuses[0];
}

function lane(name: string) {
  return screen.getByRole("listbox", { name });
}

function skeletons() {
  return [...document.querySelectorAll(".animate-pulse")];
}

function lanes() {
  return screen
    .queryAllByRole("listbox")
    .map((lane) => lane.getAttribute("aria-label"));
}

function nextEvent(tomorrow: boolean) {
  return {
    id: "review",
    title: "Design review",
    at: new Date(Date.now() + 45 * 60_000).toISOString(),
    url: "https://calendar.example.com/review",
    tomorrow,
  };
}

/** Yesterday's All clear, with its counts and next meeting, read this morning. */
function savedYesterday() {
  const timeZone = "UTC";
  const yesterday = Date.now() - 86_400_000;
  writeCachedToday({
    emailAccountId: "account",
    timeZone,
    now: yesterday,
    data: {
      ...homeData([]),
      alsoInInbox: [thread("b", "Dentist")],
      today: { checked: 42, filed: 12, filedLabel: null },
      calendar: {
        connected: true,
        clearThroughTomorrow: false,
        next: {
          id: "review",
          title: "Design review",
          at: new Date(Date.now() + 3_600_000).toISOString(),
          url: undefined,
          tomorrow: true,
        },
      },
    },
  });
  const copy = readCachedToday({ emailAccountId: "account", timeZone });
  expect(copy?.earlierDay).toBe(true);
  return copy;
}

const NUDGE = "Nudge: follow up on conversation";
const SHIFT_N = { key: "N", code: "KeyN", shiftKey: true };

type TodayCatchUpProps = Parameters<typeof CatchUpEntry>[0];

function latestCatchUpProps() {
  const props = mocks.catchUpProps.at(-1) as TodayCatchUpProps | undefined;
  if (!props?.onRemoved) throw new Error("Today rendered no Catch up");
  return { ...props, onRemoved: props.onRemoved };
}

/** Account a's a1, a copy of which is account b's b1. */
function caughtUpCard(): CatchUpItem {
  return {
    key: "account:a1",
    accountId: "account",
    threadId: "a1",
    latestMessageId: "a1-message",
    messageKey: "<shared@example.com>",
    inInbox: true,
    unread: true,
    copies: [
      { accountId: "account-b", threadId: "b1", inInbox: true, unread: true },
    ],
    sender: "Ada",
    subject: "Quarterly numbers",
    preview: "",
    atMs: 1,
  };
}

function renderToday() {
  return render(
    <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
      <HomeDashboard />
    </ShortcutsProvider>,
  );
}

function rowFor(threadId: string) {
  const row = document.querySelector<HTMLElement>(
    `[data-today-thread="${threadId}"]`,
  );
  if (!row) throw new Error(`No row for ${threadId}`);
  return row;
}

function optionFor(threadId: string) {
  return within(rowFor(threadId)).getByRole("option");
}

function thread(threadId: string, subject: string): HomeThread {
  return {
    threadId,
    fromName: "Grace Hopper",
    fromEmail: "grace@example.com",
    subject,
    preview: "Can you take a look?",
    at: "2026-10-13T09:00:00.000Z",
    priority: "medium",
    unread: true,
    messageId: `${threadId}-message`,
    starred: false,
    inInbox: true,
  };
}

function newsletter(
  threadId: string,
  fromName: string,
  subject: string,
): HomeThread {
  return { ...thread(threadId, subject), fromName, tag: "Newsletter" };
}

function localConversation(
  conversationId: string,
  subject: string,
  labelIds: string[] = [],
): ConversationSummary {
  return {
    key: { accountId: "account", conversationId },
    subject,
    preview: "Can you take a look?",
    from: "Grace Hopper <grace@example.com>",
    to: "ada@example.com",
    senders: ["Grace Hopper <grace@example.com>"],
    latestMessageAtMs: Date.now() - 60 * 60 * 1000,
    unread: true,
    starred: false,
    labelIds,
    roles: ["inbox"],
    pendingOperationIds: [],
    latestMessageId: `${conversationId}-message`,
  };
}

function syncedView(
  conversations: ConversationSummary[],
  accounts: { id: string }[],
): MailboxView {
  return {
    conversations,
    counts: {
      matchingConversations: conversations.length,
      unreadConversations: 0,
      extent: "local_coverage",
    },
    nextPage: null,
    coverage: accounts.map(({ id }) => ({
      accountId: id,
      scopeId: "primary",
      metadata: "complete",
      content: "not_requested",
      indexedContent: "not_requested",
      lastCompletedSyncAtMs: 1,
    })),
    connection: "ready",
  };
}

function day(
  events: GetCalendarTodayEventsResponse["events"],
): GetCalendarTodayEventsResponse {
  return { events, more: 0 };
}

function dayMeeting(
  id: string,
  title: string,
  startTime: string,
): GetCalendarTodayEventsResponse["events"][number] {
  return {
    id,
    title,
    startTime,
    endTime: new Date(new Date(startTime).getTime() + 1_800_000).toISOString(),
    attendees: [],
  };
}

function unread(home: GetHomeResponse): GetHomeResponse {
  return {
    ...home,
    cue: { aiAccess: true, replyTracking: true, hasReadMail: false },
  };
}

function homeData(needsYou: HomeThread[]): GetHomeResponse {
  return {
    needsYou,
    waiting: [],
    alsoInInbox: [],
    reading: [],
    newsletterThreadIds: [],
    handledLabelIds: [],
    pending: [],
    failed: [],
    agentTasks: [],
    cue: { aiAccess: true, replyTracking: true, hasReadMail: true },
    today: { checked: 0, filed: 0, filedLabel: null },
    calendar: { connected: true, clearThroughTomorrow: false, next: null },
    nextUp: [],
    suggestion: null,
    stats: {
      needsYou: needsYou.length,
      estimatedMinutes: 0,
      agentWorking: 0,
      waiting: 0,
      needsYouCapped: false,
      waitingCapped: false,
      readingCapped: false,
    },
  };
}
