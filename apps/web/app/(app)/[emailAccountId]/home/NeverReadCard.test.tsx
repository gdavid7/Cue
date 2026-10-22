// @vitest-environment jsdom

import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  MailboxView,
  NeverReadSender,
} from "@inboxzero/mail-core/queries";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";
import type { TodayAccount } from "@/utils/home/merge-home";
import { NeverReadCard } from "./NeverReadCard";
import { useNeverReadSenders } from "./use-never-read-senders";

const DAY = 86_400_000;
const DEALS: NeverReadSender = {
  accountId: "a",
  email: "deals@shop.example",
  name: "Daily Deals",
  count: 9,
  lastReceivedAtMs: Date.now() - DAY,
};
const NEWS: NeverReadSender = {
  accountId: "a",
  email: "news@paper.example",
  name: null,
  count: 4,
  lastReceivedAtMs: Date.now() - 2 * DAY,
};

const mocks = vi.hoisted(() => ({
  queryNeverReadSenders: vi.fn(),
  inbox: {
    status: "ready" as "ready" | "loading",
    data: null as MailboxView | null,
  },
  user: undefined as
    | { id: string; createdAt: Date; dismissedHints: string[] }
    | undefined,
  fetch: vi.fn(),
  unsubscribeSenderAction: vi.fn(),
  setSenderStatusAction: vi.fn(),
  queueArchiveSenders: vi.fn(),
  openModal: vi.fn(),
  toastError: vi.fn(),
  provider: "google",
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({
    queryNeverReadSenders: mocks.queryNeverReadSenders,
  }),
}));
vi.mock("@inboxzero/mail-react/use-mailbox-window", () => ({
  useMailboxWindow: (_query: unknown, { enabled }: { enabled: boolean }) =>
    enabled
      ? {
          status: mocks.inbox.status,
          data: mocks.inbox.data,
          revision: { databaseEpoch: "e", sequence: 1 },
        }
      : { status: "loading", data: null, revision: null },
}));
vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({ data: mocks.user }),
}));
vi.mock("@/hooks/useAccounts", () => ({
  useAccounts: () => ({
    data: {
      emailAccounts: [{ id: "a", account: { provider: mocks.provider } }],
    },
  }),
}));
vi.mock("@/hooks/usePremium", () => ({
  usePremium: () => ({
    hasUnsubscribeAccess: true,
    mutate: () => Promise.resolve(),
  }),
}));
vi.mock("@/app/(app)/premium/PremiumModal", () => ({
  usePremiumModal: () => ({
    PremiumModal: () => null,
    openModal: mocks.openModal,
  }),
}));
vi.mock("@/utils/fetch", () => ({ fetchWithAccount: mocks.fetch }));
vi.mock("@/utils/actions/unsubscriber", () => ({
  unsubscribeSenderAction: mocks.unsubscribeSenderAction,
  setSenderStatusAction: mocks.setSenderStatusAction,
}));
vi.mock("@/utils/actions/premium", () => ({
  decrementUnsubscribeCreditAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/store/archive-sender-queue", () => ({
  useArchiveSenderQueueActions: () => ({
    queueArchiveSenders: mocks.queueArchiveSenders,
  }),
}));
vi.mock("sonner", () => ({
  toast: {
    loading: vi.fn(() => "toast"),
    success: vi.fn(),
    error: mocks.toastError,
  },
}));

const ACCOUNTS: TodayAccount[] = [{ id: "a", email: "me@example.com" }];

beforeEach(() => {
  resetBrowserCacheForTesting();
  mocks.inbox.status = "ready";
  mocks.inbox.data = view({ synced: true });
  mocks.user = {
    id: "user-1",
    createdAt: new Date(Date.now() - DAY),
    dismissedHints: [],
  };
  mocks.queryNeverReadSenders.mockResolvedValue([DEALS, NEWS]);
  mocks.queueArchiveSenders.mockResolvedValue(1);
  mocks.provider = "google";
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("Mail you never read", () => {
  it("lists senders from local mail, read for the user's accounts over 30 days", async () => {
    renderCard();

    const list = await screen.findByRole("region", {
      name: "Mail you never read",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(within(list).getByText("Daily Deals")).toBeTruthy();
    expect(within(list).getByText("deals@shop.example")).toBeTruthy();
    expect(
      within(list).getByText(/^9 emails, none opened · latest/),
    ).toBeTruthy();
    // A sender with no name shows their address once.
    expect(within(list).getByText(/^4 emails, none opened/)).toBeTruthy();
    const [query] = mocks.queryNeverReadSenders.mock.calls[0];
    expect(query.accountIds).toEqual(["a"]);
    expect(query.ownAddresses).toEqual(["me@example.com"]);
    expect(Date.now() - query.receivedSinceMs).toBeGreaterThanOrEqual(
      30 * DAY - 1000,
    );
    expect(
      screen.getByText(
        "Frequent senders you haven't opened in 30 days. Counted on this device.",
      ),
    ).toBeTruthy();
  });

  it("says since when, while this browser holds less than 30 days", async () => {
    mocks.inbox.data = view({
      synced: true,
      windowStartMs: Date.now() - 10 * DAY,
    });
    renderCard();

    expect(
      await screen.findByText(/^Frequent senders you haven't opened since /),
    ).toBeTruthy();
    expect(screen.queryByText(/in 30 days/)).toBeNull();
  });

  it("fills up to five from past the hidden senders", async () => {
    const many = Array.from({ length: 7 }, (_, index) => ({
      ...NEWS,
      email: `s${index}@x.example`,
      name: `Sender ${index}`,
    }));
    mocks.queryNeverReadSenders.mockResolvedValue(many);
    renderCard();

    fireEvent.click(
      await screen.findByRole("button", { name: "Not now for Sender 0" }),
    );

    const region = screen.getByRole("region", { name: "Mail you never read" });
    expect(within(region).getAllByRole("listitem")).toHaveLength(5);
    expect(within(region).getByText("Sender 5")).toBeTruthy();
    expect(mocks.queryNeverReadSenders.mock.calls[0][0].limit).toBeGreaterThan(
      5,
    );
  });

  it("waits for the first sync to finish before reading", async () => {
    mocks.inbox.data = view({ synced: false });
    const { rerender } = renderCard();
    await settle();
    expect(mocks.queryNeverReadSenders).not.toHaveBeenCalled();
    expect(screen.queryByText("Mail you never read")).toBeNull();

    mocks.inbox.data = view({ synced: true });
    rerender(<Harness />);
    expect(await screen.findByText("Mail you never read")).toBeTruthy();
  });

  it("shows only in the first week, and not once Get started is closed", async () => {
    mocks.user = {
      id: "user-1",
      createdAt: new Date(Date.now() - 8 * DAY),
      dismissedHints: [],
    };
    const { unmount } = renderCard();
    await settle();
    expect(mocks.queryNeverReadSenders).not.toHaveBeenCalled();
    unmount();

    mocks.user = {
      id: "user-1",
      createdAt: new Date(Date.now() - DAY),
      dismissedHints: ["get-started:dismissed"],
    };
    renderCard();
    await settle();
    expect(mocks.queryNeverReadSenders).not.toHaveBeenCalled();
  });

  it("stays away without asking again when the engine can't answer", async () => {
    mocks.queryNeverReadSenders.mockRejectedValue(
      new Error("unsupported method queryNeverReadSenders"),
    );
    renderCard();
    await settle();
    expect(mocks.queryNeverReadSenders).toHaveBeenCalledTimes(1);
    expect(screen.queryByText("Mail you never read")).toBeNull();
  });

  it("Not now hides a sender in this browser, and the card once all are hidden", async () => {
    const { unmount } = renderCard();
    fireEvent.click(
      await screen.findByRole("button", { name: "Not now for Daily Deals" }),
    );
    expect(screen.queryByText("Daily Deals")).toBeNull();
    unmount();

    renderCard();
    expect(
      await screen.findByRole("button", {
        name: "Not now for news@paper.example",
      }),
    ).toBeTruthy();
    expect(screen.queryByText("Daily Deals")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", { name: "Not now for news@paper.example" }),
    );
    expect(screen.queryByText("Mail you never read")).toBeNull();
  });

  it("Unsubscribe asks first, then unsubscribes and archives the sender's mail", async () => {
    mocks.fetch.mockResolvedValue(
      stats("https://shop.example/unsubscribe?u=1"),
    );
    mocks.unsubscribeSenderAction.mockResolvedValue({
      data: { unsubscribe: { success: true } },
    });
    renderCard();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Unsubscribe from Daily Deals",
      }),
    );
    const dialog = await screen.findByRole("alertdialog");
    expect(mocks.unsubscribeSenderAction).not.toHaveBeenCalled();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Unsubscribe" }),
    );

    await waitFor(() =>
      expect(mocks.unsubscribeSenderAction).toHaveBeenCalledWith("a", {
        senderEmail: "deals@shop.example",
        unsubscribeLink: "https://shop.example/unsubscribe?u=1",
        listUnsubscribeHeader: undefined,
      }),
    );
    await waitFor(() =>
      expect(mocks.queueArchiveSenders).toHaveBeenCalledWith({
        senders: ["deals@shop.example"],
      }),
    );
    await waitFor(() => expect(screen.queryByText("Daily Deals")).toBeNull());
    // Focus moves on to the next sender, not back to the page.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", {
          name: "Unsubscribe from news@paper.example",
        }),
      ),
    );
    expect(mocks.fetch.mock.calls[0][0]).toMatchObject({
      url: "/api/user/stats/newsletters/unsubscribe-link?sender=deals%40shop.example",
      emailAccountId: "a",
    });
  });

  it("looks the link up once while a lookup is under way, and keeps focus", async () => {
    let answer: (response: Response) => void = () => {};
    mocks.fetch.mockReturnValue(
      new Promise<Response>((resolve) => {
        answer = resolve;
      }),
    );
    renderCard();
    const button = await screen.findByRole("button", {
      name: "Unsubscribe from Daily Deals",
    });
    button.focus();
    fireEvent.click(button);
    fireEvent.click(button);

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(button);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    answer(stats(null));
    await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
  });

  it("without an unsubscribe link says so and never blocks the sender", async () => {
    mocks.fetch.mockResolvedValue(stats(null));
    renderCard();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Unsubscribe from Daily Deals",
      }),
    );

    await waitFor(() =>
      expect(mocks.toastError).toHaveBeenCalledWith(
        "Couldn't find an unsubscribe link for Daily Deals",
      ),
    );
    expect(mocks.setSenderStatusAction).not.toHaveBeenCalled();
    expect(mocks.unsubscribeSenderAction).not.toHaveBeenCalled();
    expect(screen.getByText("Daily Deals")).toBeTruthy();
  });
});

describe("Skip inbox", () => {
  it("says it adds a Gmail filter, then marks the sender auto-archived and archives their mail", async () => {
    mocks.setSenderStatusAction.mockResolvedValue({ data: {} });
    renderCard();

    fireEvent.click(
      await screen.findByRole("button", {
        name: "Skip inbox (adds a Gmail filter) for Daily Deals",
      }),
    );

    await waitFor(() =>
      expect(mocks.setSenderStatusAction).toHaveBeenCalledWith("a", {
        senderEmail: "deals@shop.example",
        status: "AUTO_ARCHIVED",
        labelId: undefined,
        labelName: undefined,
      }),
    );
    expect(mocks.queueArchiveSenders).toHaveBeenCalledWith({
      senders: ["deals@shop.example"],
    });
    await waitFor(() => expect(screen.queryByText("Daily Deals")).toBeNull());
  });

  it("says it adds an Outlook rule on Outlook", async () => {
    mocks.provider = "microsoft";
    renderCard();
    expect(
      await screen.findByRole("button", {
        name: "Skip inbox (adds an Outlook rule) for Daily Deals",
      }),
    ).toBeTruthy();
  });
});

function Harness() {
  const { senders, sinceMs, hide } = useNeverReadSenders({
    accounts: ACCOUNTS,
  });
  return (
    <NeverReadCard
      accountColorIndexById={{}}
      onHide={hide}
      senders={senders}
      sinceMs={sinceMs}
    />
  );
}

function renderCard() {
  return render(<Harness />, {
    wrapper: ({ children }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    ),
  });
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

function view({
  synced,
  windowStartMs,
}: {
  synced: boolean;
  windowStartMs?: number;
}): MailboxView {
  return {
    conversations: [],
    coverage: [
      {
        accountId: "a",
        lastCompletedSyncAtMs: synced ? Date.now() : null,
        windowStartMs,
      },
    ],
  } as unknown as MailboxView;
}

function stats(unsubscribeLink: string | null) {
  return new Response(JSON.stringify({ unsubscribeLink }), { status: 200 });
}
