// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationSummary } from "@inboxzero/mail-core/queries";
import { CatchUpEntry } from "./CatchUp";

const UNTIL = new Date("2026-10-23T09:00:00");

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
  useMailboxWindow: () => ({
    status: "ready",
    data: {
      counts: { matchingConversations: 2 },
      coverage: [{ accountId: "account", lastCompletedSyncAtMs: 1 }],
    },
  }),
}));
vi.mock("./use-catch-up-mailbox", () => ({
  useCatchUpMailbox: () => ({
    batch: {
      status: "ready",
      conversations: [
        conversation("first", "First", 1),
        conversation("second", "Second", 2),
      ],
    },
    watch: null,
  }),
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

function conversation(
  id: string,
  subject: string,
  atMs: number,
): ConversationSummary {
  return {
    key: { accountId: "account", conversationId: id },
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
