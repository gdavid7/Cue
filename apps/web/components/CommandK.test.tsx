// @vitest-environment jsdom

import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { getDefaultStore } from "jotai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Command } from "@/lib/commands/types";
import type { ShortcutHandlers } from "@/lib/shortcuts/registry";
import { CommandK } from "./CommandK";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import {
  commandPaletteOpenAtom,
  mailCommandContextAtom,
} from "@/store/command-palette";
import { useSnoozeDateParser } from "@/hooks/useSnoozeDateParser";

const displayedEmail = vi.hoisted(() => ({
  showEmail: vi.fn(),
  threadId: "thread-1" as string | null,
  accountId: "account-1" as string | null,
}));
const threadLookup = vi.hoisted(() => ({
  calls: [] as Array<{ id: string | null; emailAccountId?: string }>,
}));
const thread = vi.hoisted(() => ({
  data: {
    thread: {
      id: "thread-1",
      messages: [{ id: "message-1" }, { id: "message-2" }],
    },
  } as { thread: { id: string; messages: { id: string }[] } } | undefined,
  isLoading: false,
}));
const mail = vi.hoisted(() => ({
  client: {
    getDiagnostics: vi.fn(),
    submitConversations: vi.fn(),
  },
}));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => mail.client,
}));
const notifications = vi.hoisted(() => ({ error: vi.fn() }));
const shortcuts = vi.hoisted(() => ({
  handlers: undefined as ShortcutHandlers | undefined,
}));

vi.mock("@/components/AccountCommandList", () => ({
  AccountCommandList: () => null,
}));
vi.mock("@/hooks/useDisplayedEmail", () => ({
  useDisplayedEmail: () => ({
    threadId: displayedEmail.threadId,
    accountId: displayedEmail.accountId,
    showEmail: displayedEmail.showEmail,
  }),
}));
vi.mock("@/hooks/useThread", () => ({
  useThread: (args: { id: string | null; emailAccountId?: string }) => {
    threadLookup.calls.push(args);
    return { data: thread.data, isLoading: thread.isLoading };
  },
}));
vi.mock("@/providers/ComposeModalProvider", () => ({
  useComposeModal: () => ({ onOpen: vi.fn() }),
}));
vi.mock("@/components/Toast", () => ({
  toastError: notifications.error,
  toastSuccess: vi.fn(),
}));
const palette = vi.hoisted(() => ({
  commands: [] as Command[],
  mailCommands: [] as Command[],
}));
vi.mock("@/hooks/useCommandPaletteCommands", () => ({
  useCommandPaletteCommands: () => ({
    commands: palette.commands,
    isLoading: false,
  }),
}));
vi.mock("@/lib/shortcuts/useShortcuts", () => ({
  useShortcuts: (handlers: ShortcutHandlers) => {
    shortcuts.handlers = handlers;
  },
}));
vi.mock("@/lib/shortcuts/ShortcutsProvider", () => ({
  ShortcutsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/shortcuts/registry", () => ({
  buildShortcutPaletteCommands: () => [],
  MAIL_SHORTCUT_SCOPES: [],
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/mail-command-palette", () => ({
  buildMailCommandPalette: () => palette.mailCommands,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/ShortcutsDialog", () => ({
  ShortcutsDialog: () => null,
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/snooze-command-palette", () => ({
  buildSnoozeCommandPalette: () => [],
}));
vi.mock("@/lib/commands/fuzzy-search", () => ({ fuzzySearch: () => [] }));
const quiet = vi.hoisted(() => ({
  canPause: false,
  quietUntilMs: null as number | null,
}));
vi.mock("@/hooks/useNotificationsQuiet", () => ({
  useNotificationsQuiet: () => quiet,
}));
vi.mock("@/utils/web-push/subscription", () => ({
  isWebPushAvailable: () => false,
  syncWebPushQuietUntil: vi.fn(async () => true),
  syncWebPushSubscription: vi.fn(async () => true),
}));
vi.mock("@/hooks/useSnoozeDateParser", () => ({
  useSnoozeDateParser: vi.fn(() => null),
}));
vi.mock("@/components/ui/command", () => ({
  CommandDialog: ({ children }: { children: React.ReactNode }) => children,
  CommandEmpty: () => null,
  CommandGroup: ({
    children,
    heading,
  }: {
    children: React.ReactNode;
    heading: string;
  }) => (
    <div aria-label={heading} role="group">
      {children}
    </div>
  ),
  CommandInput: () => null,
  CommandItem: ({ children }: { children: React.ReactNode }) => children,
  CommandList: ({ children }: { children: React.ReactNode }) => children,
  CommandSeparator: () => null,
  CommandShortcut: () => null,
}));

describe("CommandK side-panel actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    displayedEmail.threadId = "thread-1";
    displayedEmail.accountId = "account-1";
    threadLookup.calls = [];
    thread.data = {
      thread: {
        id: "thread-1",
        messages: [{ id: "message-1" }, { id: "message-2" }],
      },
    };
    thread.isLoading = false;
    mail.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mail.client.submitConversations.mockResolvedValue({ status: "queued" });
    shortcuts.handlers = undefined;
  });

  afterEach(cleanup);

  it("queues archive through the engine before closing the viewer", async () => {
    const persisted = Promise.withResolvers<{ status: string }>();
    mail.client.submitConversations.mockReturnValue(persisted.promise);
    render(<CommandK />);

    let archive: Promise<void> | undefined;
    act(() => {
      archive = shortcuts.handlers?.archive?.() as Promise<void> | undefined;
    });

    await waitFor(() =>
      expect(mail.client.submitConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "account-1",
          conversations: [
            { accountId: "account-1", conversationId: "thread-1" },
          ],
          change: { kind: "archive" },
        }),
      ),
    );
    expect(displayedEmail.showEmail).not.toHaveBeenCalled();

    persisted.resolve({ status: "queued" });
    await act(async () => archive);
    expect(displayedEmail.showEmail).toHaveBeenCalledWith(null);
  });

  it("keeps the viewer open when durable storage fails", async () => {
    mail.client.submitConversations.mockRejectedValue(
      new Error("storage unavailable"),
    );
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.archive?.());

    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: "Couldn't queue archiving this email",
    });
  });

  it("explains a full command queue instead of a generic archive failure", async () => {
    mail.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.archive?.());

    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: admissionRejectionCopy("queue_full"),
    });
  });

  it("keeps star bound while the side-panel thread is loading", async () => {
    thread.data = undefined;
    thread.isLoading = true;
    render(<CommandK />);
    await act(async () => shortcuts.handlers?.star?.());
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: "Email is still loading",
    });
  });

  it("stars the displayed thread through the engine", async () => {
    render(<CommandK />);
    await act(async () => shortcuts.handlers?.star?.());
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { kind: "set_starred", starred: true },
      }),
    );
  });

  it("keeps archive bound while the full thread snapshot is loading", async () => {
    thread.data = undefined;
    thread.isLoading = true;
    render(<CommandK />);

    expect(shortcuts.handlers?.archive).toBeTypeOf("function");

    await act(async () => shortcuts.handlers?.archive?.());

    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(displayedEmail.showEmail).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith({
      description: "Email is still loading",
    });
  });

  it("archives and stars the side-panel thread in the account it belongs to", async () => {
    displayedEmail.accountId = "account-2";
    render(<CommandK />);

    await act(async () => shortcuts.handlers?.archive?.());
    await act(async () => shortcuts.handlers?.star?.());

    expect(threadLookup.calls.at(-1)).toEqual({
      id: "thread-1",
      emailAccountId: "account-2",
    });
    const submittedAccounts = mail.client.submitConversations.mock.calls.map(
      ([command]) => ({
        accountId: command.accountId,
        conversations: command.conversations,
      }),
    );
    expect(submittedAccounts).toEqual([
      {
        accountId: "account-2",
        conversations: [{ accountId: "account-2", conversationId: "thread-1" }],
      },
      {
        accountId: "account-2",
        conversations: [{ accountId: "account-2", conversationId: "thread-1" }],
      },
    ]);
  });

  it("opens a forward composer for the latest side-panel message", () => {
    render(<CommandK />);

    act(() => shortcuts.handlers?.forward?.());

    expect(displayedEmail.showEmail).toHaveBeenCalledWith({
      threadId: "thread-1",
      accountId: "account-1",
      autoOpenForwardForMessageId: "message-2",
      showReplyButton: true,
    });
  });
});

describe("CommandK snooze date parser", () => {
  afterEach(() => {
    cleanup();
    const store = getDefaultStore();
    store.set(commandPaletteOpenAtom, false);
    store.set(mailCommandContextAtom, null);
  });

  it("starts loading as the palette opens where mail can be snoozed", () => {
    displayedEmail.threadId = null;
    const store = getDefaultStore();
    store.set(mailCommandContextAtom, {
      actions: { archive: vi.fn(), snooze: vi.fn() },
      hasRead: false,
      hasUnread: false,
      targetCount: 1,
    });
    store.set(commandPaletteOpenAtom, true);

    render(<CommandK />);

    expect(vi.mocked(useSnoozeDateParser)).toHaveBeenLastCalledWith(true);
  });
});

describe("CommandK across accounts", () => {
  afterEach(() => {
    cleanup();
    const store = getDefaultStore();
    store.set(commandPaletteOpenAtom, false);
    store.set(mailCommandContextAtom, null);
    palette.commands = [];
    palette.mailCommands = [];
  });

  it("says which account the selected mail's actions run in", () => {
    displayedEmail.threadId = null;
    palette.mailCommands = [
      { id: "archive", label: "Archive", section: "actions", action: vi.fn() },
    ];
    const store = getDefaultStore();
    store.set(mailCommandContextAtom, {
      account: "b@example.com",
      actions: { archive: vi.fn() },
      hasRead: false,
      hasUnread: true,
      targetCount: 1,
    });

    render(<CommandK />);

    const actions = screen.getByRole("group", {
      name: "Actions · b@example.com",
    });
    expect(within(actions).getByText("Archive")).toBeTruthy();
  });

  it("names the account an account's own page opens in", () => {
    displayedEmail.threadId = null;
    palette.commands = [
      {
        id: "nav-rules",
        label: "Go to Rules",
        account: "a@example.com",
        section: "navigation",
        action: vi.fn(),
      },
    ];

    render(<CommandK />);

    const navigation = screen.getByRole("group", { name: "Navigation" });
    expect(within(navigation).getByText("Go to Rules")).toBeTruthy();
    expect(within(navigation).getByText("a@example.com")).toBeTruthy();
  });
});

describe("CommandK pausing notifications", () => {
  afterEach(() => {
    cleanup();
    quiet.canPause = false;
    quiet.quietUntilMs = null;
  });

  it("offers a pause only where this browser notifies", () => {
    displayedEmail.threadId = null;
    render(<CommandK />);
    expect(screen.queryByText("Pause notifications…")).toBeNull();
    cleanup();

    quiet.canPause = true;
    render(<CommandK />);
    const settings = screen.getByRole("group", { name: "Settings" });
    expect(within(settings).getByText("Pause notifications…")).toBeTruthy();
  });

  it("offers to resume, saying until when, while paused", () => {
    displayedEmail.threadId = null;
    quiet.canPause = true;
    quiet.quietUntilMs = Date.now() + 60 * 60 * 1000;

    render(<CommandK />);

    const settings = screen.getByRole("group", { name: "Settings" });
    expect(within(settings).getByText("Resume notifications")).toBeTruthy();
    expect(within(settings).getByText(/^Paused until /)).toBeTruthy();
    expect(within(settings).queryByText("Pause notifications…")).toBeNull();
  });
});
