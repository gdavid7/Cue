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
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GetHomeResponse } from "@/app/api/user/home/route";
import { ShortcutsProvider } from "@/lib/shortcuts/ShortcutsProvider";
import { MAIL_SHORTCUT_SCOPES } from "@/lib/shortcuts/registry";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";
import type { HomeThread } from "@/utils/home/get-home";
import { readCachedToday, writeCachedToday } from "@/utils/home/today-cache";
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
  markNeedsReply: vi.fn(),
  markNoReplyNeeded: vi.fn(),
  toastUndo: vi.fn(),
  undoLatestToast: vi.fn(),
  home: {
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
vi.mock("@/hooks/useHome", () => ({
  // A stand-in for SWR's cache: local mutations apply, nothing revalidates.
  useHome: (emailAccountId?: string | null) => {
    const [data, setData] = useState(
      emailAccountId && emailAccountId in mocks.homes
        ? mocks.homes[emailAccountId]
        : mocks.home.data,
    );
    return {
      data,
      isLoading: false,
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

  it("busy with deadlines: lists what's next, soonest first, each with its source", () => {
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
          at: new Date(Date.now() + 3_600_000).toISOString(),
          source: "Calendar",
          url: "https://calendar.example.com/review",
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

    // The meeting is in the list below, so the summary doesn't repeat it.
    expect(onlyStatus().textContent).toBe("1 needs a reply");
    const nextUp = screen.getByRole("region", { name: "Next up" });
    expect(
      within(nextUp)
        .getAllByRole("listitem")
        .map((item) => item.textContent?.replace(/^.*?(Design|OPS)/, "$1")),
    ).toEqual([
      "Design reviewCalendar (opens in a new tab)",
      "OPS-12 Rotate keysJira",
    ]);
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

  it("shows Today loading while the account list loads, not an empty page", () => {
    mocks.emailAccounts = undefined;

    renderToday();

    expect(skeletons()).not.toEqual([]);
    expect(screen.queryByText("All clear.")).toBeNull();
  });

  it("is one account's Today with one account in All inboxes", () => {
    mocks.emailAccounts = [emailAccount("account", "a@example.com")];
    mocks.home.data = homeData([thread("a1", "Quarterly numbers")]);

    renderToday();

    expect(rowFor("a1")).toBeTruthy();
    expect(screen.queryByRole("img", { name: /^Inbox:/ })).toBeNull();
  });
});

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

function homeData(needsYou: HomeThread[]): GetHomeResponse {
  return {
    needsYou,
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
    stats: {
      needsYou: needsYou.length,
      estimatedMinutes: 0,
      agentWorking: 0,
      waiting: 0,
      needsYouCapped: false,
      waitingCapped: false,
    },
  };
}
