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
import type { MailboxView, RecentBounce } from "@inboxzero/mail-core/queries";
import { resetBrowserCacheForTesting } from "@/utils/browser-cache";
import type { TodayAccount } from "@/utils/home/merge-home";
import { BounceNotices } from "./BounceNotices";
import { useRecentBounces } from "./use-recent-bounces";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PLAN: RecentBounce = {
  accountId: "a",
  conversationId: "c-plan",
  messageId: "m-plan-bounce",
  subject: "Delivery Status Notification (Failure)",
  sentSubject: "Re: Quarterly plan",
  receivedAtMs: Date.now() - HOUR,
  answeredAfter: false,
};
const LONE: RecentBounce = {
  accountId: "b",
  conversationId: "c-lone",
  messageId: "m-lone",
  subject: "Undeliverable: Lunch",
  sentSubject: null,
  receivedAtMs: Date.now() - 2 * DAY,
  answeredAfter: false,
};

const mocks = vi.hoisted(() => ({
  queryRecentBounces: vi.fn(),
  capabilities: ["method:queryRecentBounces"],
  inbox: {
    status: "ready" as "ready" | "loading",
    data: null as MailboxView | null,
  },
  user: { id: "user-1" } as { id: string } | undefined,
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({
    capabilities: mocks.capabilities,
    queryRecentBounces: mocks.queryRecentBounces,
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

const ACCOUNTS: TodayAccount[] = [
  { id: "a", email: "me@example.com" },
  { id: "b", email: "me@work.example" },
];

beforeEach(() => {
  resetBrowserCacheForTesting();
  mocks.inbox.status = "ready";
  mocks.inbox.data = view({ synced: true });
  mocks.user = { id: "user-1" };
  mocks.queryRecentBounces.mockResolvedValue([PLAN, LONE]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

describe("Didn't send", () => {
  it("shows a card per bounce, named for what was sent when it can be", async () => {
    renderCards();

    const list = await screen.findByRole("list", { name: "Didn't send" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(2);
    expect(within(cards[0]).getByText("Didn't send")).toBeTruthy();
    // The sent message's subject, without its reply prefix.
    expect(within(cards[0]).getByText("Quarterly plan")).toBeTruthy();
    expect(within(cards[0]).queryByText(PLAN.subject)).toBeNull();
    // Nothing sent in its conversation: the bounce's own subject.
    expect(within(cards[1]).getByText("Undeliverable: Lunch")).toBeTruthy();

    const [query] = mocks.queryRecentBounces.mock.calls[0];
    expect(query.accountIds).toEqual(["a", "b"]);
    expect(Date.now() - query.receivedSinceMs).toBeGreaterThanOrEqual(
      7 * DAY - 1000,
    );
  });

  it("opens each bounce's conversation in its own account", async () => {
    renderCards({ named: true });

    const list = await screen.findByRole("list", { name: "Didn't send" });
    const [plan, lone] = within(list).getAllByRole("listitem");
    expect(
      within(plan).getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/a/mail?thread=c-plan");
    expect(
      within(lone).getByRole("link", { name: "Open" }).getAttribute("href"),
    ).toBe("/b/mail?thread=c-lone");
    // Across accounts each card names its account.
    expect(
      within(lone).getByRole("img", { name: "Account: me@work.example" }),
    ).toBeTruthy();
  });

  it("stays dismissed in this browser, until a newer bounce in the conversation", async () => {
    const { unmount } = renderCards();
    const list = await screen.findByRole("list", { name: "Didn't send" });
    const [plan] = within(list).getAllByRole("listitem");
    within(plan).getByRole("link", { name: "Open" }).focus();

    fireEvent.click(within(plan).getByRole("button", { name: "Dismiss" }));

    expect(screen.queryByText("Quarterly plan")).toBeNull();
    expect(screen.getAllByRole("listitem")).toHaveLength(1);
    // Focus moves to the card that took its place.
    await waitFor(() =>
      expect(document.activeElement?.textContent).toBe("Open"),
    );

    unmount();
    renderCards();
    expect(await screen.findByText("Undeliverable: Lunch")).toBeTruthy();
    expect(screen.queryByText("Quarterly plan")).toBeNull();

    cleanup();
    mocks.queryRecentBounces.mockResolvedValue([
      { ...PLAN, messageId: "m-plan-second", receivedAtMs: Date.now() },
      LONE,
    ]);
    renderCards();
    expect(await screen.findByText("Quarterly plan")).toBeTruthy();
  });

  it("returns focus to Today when the last card is dismissed", async () => {
    mocks.queryRecentBounces.mockResolvedValue([LONE]);
    renderCards();
    const dismiss = await screen.findByRole("button", { name: "Dismiss" });
    dismiss.focus();

    fireEvent.click(dismiss);

    expect(screen.queryByRole("list", { name: "Didn't send" })).toBeNull();
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByTestId("today")),
    );
  });

  it("shows at most three, filling in past dismissed ones", async () => {
    mocks.queryRecentBounces.mockResolvedValue(
      Array.from({ length: 5 }, (_, index) => ({
        ...LONE,
        conversationId: `c${index}`,
        messageId: `m${index}`,
        subject: `Bounce ${index}`,
      })),
    );
    renderCards();

    const list = await screen.findByRole("list", { name: "Didn't send" });
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    fireEvent.click(
      within(list).getAllByRole("button", { name: "Dismiss" })[0],
    );
    expect(within(list).getAllByRole("listitem")).toHaveLength(3);
    expect(within(list).getByText("Bounce 3")).toBeTruthy();
  });

  it("waits for every account's first sync before reading", async () => {
    mocks.inbox.data = view({ synced: false });
    const { rerender } = renderCards();
    await settle();
    expect(mocks.queryRecentBounces).not.toHaveBeenCalled();
    expect(screen.queryByText("Didn't send")).toBeNull();

    mocks.inbox.data = view({ synced: true });
    rerender(<Harness />);
    expect((await screen.findAllByText("Didn't send")).length).toBe(2);
  });

  it("doesn't ask an engine that can't answer", async () => {
    mocks.capabilities = [];
    try {
      renderCards();
      await settle();
      expect(mocks.queryRecentBounces).not.toHaveBeenCalled();
    } finally {
      mocks.capabilities = ["method:queryRecentBounces"];
    }
  });

  it("shows nothing without bounces", async () => {
    mocks.queryRecentBounces.mockResolvedValue([]);
    renderCards();
    await settle();
    expect(screen.queryByRole("list", { name: "Didn't send" })).toBeNull();
  });
});

let named = false;

function Harness() {
  const { bounces, dismiss } = useRecentBounces({ accounts: ACCOUNTS });
  return (
    <div data-testid="today" tabIndex={-1} ref={todayRef}>
      <BounceNotices
        accountColorIndexById={{ a: 0, b: 1 }}
        accounts={named ? ACCOUNTS : undefined}
        bounces={bounces}
        href={(bounce) =>
          `/${bounce.accountId}/mail?thread=${bounce.conversationId}`
        }
        onDismiss={dismiss}
        returnFocusRef={todayRef}
      />
    </div>
  );
}

const todayRef: { current: HTMLDivElement | null } = { current: null };

function renderCards(options: { named?: boolean } = {}) {
  named = Boolean(options.named);
  return render(<Harness />, {
    wrapper: ({ children }) => (
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        {children}
      </SWRConfig>
    ),
  });
}

function view({ synced }: { synced: boolean }): MailboxView {
  return {
    conversations: [],
    coverage: ACCOUNTS.map((account) => ({
      accountId: account.id,
      lastCompletedSyncAtMs: synced ? Date.now() : null,
    })),
  } as unknown as MailboxView;
}

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 20));
}
