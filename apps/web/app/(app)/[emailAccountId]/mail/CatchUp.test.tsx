// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { type CatchUpAllInboxes, CatchUpEntry } from "./CatchUp";
import type { useCatchUpMailbox } from "./use-catch-up-mailbox";

const UNTIL = new Date("2026-10-23T09:00:00");

// What the batch read answers; each test sets its own mail.
const mailbox = vi.hoisted(() => ({
  conversations: [] as ConversationSummary[],
  calls: [] as Array<Parameters<typeof useCatchUpMailbox>[0]>,
}));

vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/hooks/useUser", () => ({
  useUser: () => ({
    data: { createdAt: new Date().toISOString(), dismissedHints: [] },
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ userEmail: "me@example.com" }),
}));
vi.mock("@/hooks/useCueMembership", () => ({
  useCueMembership: () => ({ membership: null }),
}));
vi.mock("@/utils/analytics/mail-usage", () => ({ trackMailAction: vi.fn() }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => ({}),
}));
vi.mock("@inboxzero/mail-react/use-mailbox-window", () => ({
  useMailboxWindow: (query: { accountIds: string[] }) => ({
    status: "ready",
    data: {
      counts: { matchingConversations: 2 },
      coverage: query.accountIds.map((accountId) => ({
        accountId,
        lastCompletedSyncAtMs: 1,
      })),
    },
  }),
}));
vi.mock("./use-catch-up-mailbox", () => ({
  useCatchUpMailbox: (props: Parameters<typeof useCatchUpMailbox>[0]) => {
    mailbox.calls.push(props);
    return {
      batch: {
        status: "ready",
        conversations: mailbox.conversations.filter((row) =>
          props.accountIds.includes(row.key.accountId),
        ),
      },
      watch: null,
    };
  },
}));
// The picker's popover isn't under test; this picks a time straight away.
vi.mock("./SnoozeButton", () => ({
  SnoozeButton: ({
    onSnooze,
    trigger,
  }: {
    onSnooze: (until: Date) => void;
    trigger: React.ReactNode;
  }) => (
    <>
      {trigger}
      <button onClick={() => onSnooze(UNTIL)} type="button">
        Pick tomorrow
      </button>
    </>
  ),
}));

describe("Catch up", () => {
  let restoredListeners: Set<(keys: string[]) => void>;
  let actions: Parameters<typeof CatchUpEntry>[0]["actions"];

  beforeEach(() => {
    mailbox.conversations = [
      conversation("first", "First", 1),
      conversation("second", "Second", 2),
    ];
    mailbox.calls = [];
    restoredListeners = new Set();
    actions = {
      addTargets: vi.fn(),
      archive: vi.fn(async (keys: string[]) => keys),
      markRead: vi.fn(async (keys: string[]) => keys),
      setReadState: vi.fn(async (keys: string[]) => keys),
      snooze: vi.fn(async (keys: string[]) => keys),
      subscribeRestored: (listener) => {
        restoredListeners.add(listener);
        return () => restoredListeners.delete(listener);
      },
      // The view's undo takes back its last action and tells its listeners.
      undo: vi.fn(async () => {
        for (const listener of restoredListeners) listener(["first"]);
        return ["first"];
      }),
    };
  });

  afterEach(cleanup);

  it("offers undo after a snooze, and undoing brings the card back", async () => {
    render(
      <CatchUpEntry
        actions={actions}
        emailAccountId="account"
        onReply={vi.fn()}
        query={{ type: "inbox" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
    expect(await screen.findByText("2 left")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "First" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Pick tomorrow" }));

    expect(await screen.findByText("Snoozed “First”")).toBeTruthy();
    expect(actions.snooze).toHaveBeenCalledWith(["first"], UNTIL);
    expect(screen.getByRole("heading", { name: "Second" })).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: /Undo/ }));

    expect(await screen.findByRole("heading", { name: "First" })).toBeTruthy();
    expect(actions.undo).toHaveBeenCalledTimes(1);
    expect(actions.setReadState).not.toHaveBeenCalled();
    expect(screen.getByText("2 left")).toBeTruthy();
    expect(screen.queryByText("Snoozed “First”")).toBeNull();
  });

  it("takes back a snooze with Z", async () => {
    render(
      <CatchUpEntry
        actions={actions}
        emailAccountId="account"
        onReply={vi.fn()}
        query={{ type: "inbox" }}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
    await screen.findByText("2 left");
    fireEvent.click(screen.getByRole("button", { name: "Pick tomorrow" }));
    await screen.findByText("Snoozed “First”");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "z" });

    expect(await screen.findByRole("heading", { name: "First" })).toBeTruthy();
    expect(actions.undo).toHaveBeenCalledTimes(1);
  });
});

describe("Catch up in All inboxes", () => {
  let restoredListeners: Set<(keys: string[]) => void>;
  let actions: Parameters<typeof CatchUpEntry>[0]["actions"];
  let lastArchived: string[];

  beforeEach(() => {
    // Both accounts have a conversation t1; work's is the oldest.
    mailbox.conversations = [
      conversation("t1", "Work oldest", 1, "work"),
      conversation("t1", "Home middle", 2, "home"),
      conversation("t3", "Work newest", 3, "work"),
    ];
    mailbox.calls = [];
    restoredListeners = new Set();
    lastArchived = [];
    actions = {
      addTargets: vi.fn(),
      archive: vi.fn(async (keys: string[]) => {
        lastArchived = keys;
        return keys;
      }),
      markRead: vi.fn(async (keys: string[]) => keys),
      setReadState: vi.fn(async (keys: string[]) => keys),
      snooze: vi.fn(async (keys: string[]) => keys),
      subscribeRestored: (listener) => {
        restoredListeners.add(listener);
        return () => restoredListeners.delete(listener);
      },
      undo: vi.fn(async () => {
        for (const listener of restoredListeners) listener(lastArchived);
        return lastArchived;
      }),
    };
  });

  afterEach(cleanup);

  it("walks every account's mail in one order, acting in each card's own account", async () => {
    renderAllInboxes(actions);
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
    expect(await screen.findByText("3 left")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Work oldest" })).toBeTruthy();
    expect(screen.getByText("me@work.example")).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "e" });

    expect(
      await screen.findByRole("heading", { name: "Home middle" }),
    ).toBeTruthy();
    expect(screen.getByText("me@home.example")).toBeTruthy();
    expect(actions.archive).toHaveBeenCalledWith(["work:t1"]);
    expect(actions.addTargets).toHaveBeenCalledWith([
      expect.objectContaining({ id: "t1", account: { id: "work" } }),
    ]);

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "s" });

    expect(
      await screen.findByRole("heading", { name: "Work newest" }),
    ).toBeTruthy();
    expect(actions.markRead).toHaveBeenCalledWith(["home:t1"]);
    expect(actions.addTargets).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: "t1", account: { id: "home" } }),
    ]);
  });

  it("undoes a card's own action, bringing back that account's card", async () => {
    renderAllInboxes(actions);
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
    await screen.findByText("3 left");
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "e" });
    await screen.findByRole("heading", { name: "Home middle" });
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "s" });
    await screen.findByText("Marked “Home middle” as read");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "z" });

    // Keep is undone in home, not by taking back work's archive.
    expect(
      await screen.findByRole("heading", { name: "Home middle" }),
    ).toBeTruthy();
    expect(actions.setReadState).toHaveBeenCalledWith(
      ["home:t1"],
      false,
      false,
    );
    expect(actions.undo).not.toHaveBeenCalled();
    expect(screen.getByText("2 left")).toBeTruthy();
  });

  it("sets aside an account whose change is refused, and carries on with the others", async () => {
    actions.archive = vi.fn(async (keys: string[]) =>
      keys.filter((key) => !key.startsWith("work:")),
    );
    renderAllInboxes(actions);
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
    await screen.findByText("3 left");

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "e" });

    expect(
      await screen.findByRole("heading", { name: "Home middle" }),
    ).toBeTruthy();
    expect(screen.getByText("1 left")).toBeTruthy();
    expect(
      screen.getByText(
        "Couldn't update me@work.example, so its conversations are set aside for now.",
      ),
    ).toBeTruthy();

    fireEvent.keyDown(screen.getByRole("dialog"), { key: "e" });

    expect(await screen.findByText("You cleared 1 conversation.")).toBeTruthy();
  });

  it("leaves out accounts not synced or not reachable, and says so", async () => {
    renderAllInboxes(actions, {
      accounts: [...ACCOUNTS, { id: "side", email: "me@side.example" }],
      waitingAccountIds: ["home"],
      failedAccountIds: ["side"],
    });
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));

    expect(await screen.findByText("2 left")).toBeTruthy();
    expect(
      screen.getByText(
        "Mail from me@home.example is still loading, so it isn't in Catch up yet.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "me@side.example couldn't be loaded, so its mail isn't in Catch up.",
      ),
    ).toBeTruthy();
    expect(mailbox.calls.at(-1)?.accountIds).toEqual(["work"]);
  });

  it("sets aside an account that stops being reachable mid-batch", async () => {
    const view = renderAllInboxes(actions);
    fireEvent.click(screen.getByRole("button", { name: "Catch up" }));
    expect(
      await screen.findByRole("heading", { name: "Work oldest" }),
    ).toBeTruthy();

    view.rerender(allInboxesEntry(actions, { failedAccountIds: ["work"] }));

    expect(
      await screen.findByRole("heading", { name: "Home middle" }),
    ).toBeTruthy();
    expect(screen.getByText("1 left")).toBeTruthy();
    expect(
      screen.getByText(
        "me@work.example couldn't be loaded, so its mail isn't in Catch up.",
      ),
    ).toBeTruthy();
  });
});

const INBOX = { kind: "role", role: "inbox" } as const;

const ACCOUNTS = [
  { id: "work", email: "me@work.example" },
  { id: "home", email: "me@home.example" },
];

function renderAllInboxes(
  actions: Parameters<typeof CatchUpEntry>[0]["actions"],
  overrides: Partial<CatchUpAllInboxes> = {},
) {
  return render(allInboxesEntry(actions, overrides));
}

function allInboxesEntry(
  actions: Parameters<typeof CatchUpEntry>[0]["actions"],
  overrides: Partial<CatchUpAllInboxes> = {},
) {
  return (
    <CatchUpEntry
      actions={actions}
      allInboxes={{
        accounts: ACCOUNTS,
        predicate: INBOX,
        waitingAccountIds: [],
        failedAccountIds: [],
        ...overrides,
      }}
      emailAccountId="work"
      onReply={vi.fn()}
      query={{ type: "inbox" }}
    />
  );
}

function conversation(
  id: string,
  subject: string,
  atMs: number,
  accountId = "account",
): ConversationSummary {
  return {
    key: { accountId, conversationId: id },
    subject,
    preview: "",
    from: "Ada <ada@example.com>",
    to: "me@example.com",
    senders: ["Ada <ada@example.com>"],
    latestMessageAtMs: atMs,
    unread: true,
    starred: false,
    labelIds: [],
    roles: ["inbox"],
    pendingOperationIds: [],
    latestMessageId: `${id}-message`,
  };
}
