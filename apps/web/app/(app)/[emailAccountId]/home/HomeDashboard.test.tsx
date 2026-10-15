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
import type { HomeThread } from "@/utils/home/get-home";
import { HomeDashboard } from "./HomeDashboard";

const mocks = vi.hoisted(() => ({
  client: {
    cancelOperation: vi.fn(),
    getDiagnostics: vi.fn(),
    submitConversations: vi.fn(),
  },
  push: vi.fn(),
  toastUndo: vi.fn(),
  undoLatestToast: vi.fn(),
  home: { data: undefined as GetHomeResponse | undefined },
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: mocks.push }),
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
  }),
}));
vi.mock("@/hooks/useMailHref", () => ({
  useMailHref:
    () =>
    ({ threadId }: { threadId?: string } = {}) =>
      `/mail/u/0/inbox${threadId ? `/${threadId}` : ""}`,
}));
vi.mock("@/hooks/use-mobile", () => ({ useIsLargeScreen: () => true }));
vi.mock("@/hooks/useHome", () => ({
  // A stand-in for SWR's cache: local mutations apply, nothing revalidates.
  useHome: () => {
    const [data, setData] = useState(mocks.home.data);
    return {
      data,
      isLoading: false,
      error: undefined,
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
  markNoReplyNeededAction: vi.fn(),
}));
vi.mock("@/utils/actions/thread-assist", () => ({
  markNeedsReplyAction: vi.fn(),
}));
vi.mock("./BeforeYourMeeting", () => ({ BeforeYourMeeting: () => null }));

describe("HomeDashboard row actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mocks.client.submitConversations.mockResolvedValue({ status: "queued" });
    mocks.client.cancelOperation.mockResolvedValue({ status: "cancelled" });
    mocks.undoLatestToast.mockResolvedValue(false);
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

function lane(name: string) {
  return screen.getByRole("listbox", { name });
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
    handled: [],
    handledLabels: [],
    alsoInInbox: [],
    agentTasks: [],
    cue: { aiAccess: true, replyTracking: true, hasReadMail: true },
    stats: {
      needsYou: needsYou.length,
      estimatedMinutes: 0,
      agentWorking: 0,
      waiting: 0,
      handled: 0,
      handledWindowDays: 7,
      needsYouCapped: false,
      waitingCapped: false,
      handledCapped: false,
    },
  };
}
