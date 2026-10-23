// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListThread } from "./types";
import { useThreadActions } from "./use-thread-actions";
import { toastUndo } from "@/components/Toast";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import { readOptimisticTriage } from "@/utils/mail-engine/optimistic-triage";
import type { MailClient } from "@inboxzero/mail-core/engine";

const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
const mail = vi.hoisted(() => ({
  started: true,
  client: {
    cancelOperation: vi.fn(),
    ensureConversationMessages: vi.fn(),
    getDiagnostics: vi.fn(),
    observeConversation: vi.fn(),
    observeOperation: vi.fn(),
    submitConversations: vi.fn(),
    submitMetadata: vi.fn(),
  },
}));

const activation = vi.hoisted(() => ({ report: vi.fn() }));

vi.mock("@/hooks/useActivationSignal", () => ({
  reportActivationSignal: activation.report,
}));
vi.mock("sonner", () => ({ toast: notifications }));
vi.mock("@/components/Toast", () => ({ toastUndo: vi.fn() }));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => (mail.started ? mail.client : null),
}));

describe("useThreadActions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mail.started = true;
    mail.client.getDiagnostics.mockResolvedValue({ revision: 1 });
    mail.client.submitConversations.mockResolvedValue({ status: "queued" });
    mail.client.cancelOperation.mockResolvedValue({ status: "cancelled" });
    mail.client.submitMetadata.mockResolvedValue({ status: "queued" });
    mail.client.ensureConversationMessages.mockResolvedValue({
      status: "complete",
    });
  });

  it("archives through the engine with the observed revision", async () => {
    const { result } = renderActions();
    await act(() => result.current.archive(["thread"]));
    expect(mail.client.submitConversations).toHaveBeenCalledWith({
      accountId: "account",
      commandId: expect.any(String),
      conversations: [{ accountId: "account", conversationId: "thread" }],
      change: { kind: "archive" },
      observedRevision: 1,
    });
  });

  it("reports a first triage action for each account archived or snoozed", async () => {
    const threads = [
      { ...createThread(["INBOX"], "shared"), account: { id: "work" } },
      { ...createThread(["INBOX"], "shared"), account: { id: "home" } },
    ] as unknown as ListThread[];
    const { result } = renderActions({ threads });

    await act(() => result.current.archive(["work:shared", "home:shared"]));
    await act(() => result.current.snooze(["work:shared"], new Date()));

    expect(activation.report.mock.calls).toEqual([
      ["work", "first_triage_action"],
      ["home", "first_triage_action"],
      ["work", "first_triage_action"],
    ]);
  });

  it("reports no triage action when nothing was queued or the change is not a triage", async () => {
    const { result } = renderActions();
    await act(() => result.current.archive(["missing-thread"]));
    await act(() => result.current.setReadState(["thread"], true));

    expect(activation.report).not.toHaveBeenCalled();
  });

  it("watches one operation per account for a bulk archive, and survives a watcher that fails", async () => {
    const threads = Array.from({ length: 1200 }, (_, index) =>
      createThread(["INBOX"], `thread-${index}`),
    );
    mail.client.observeOperation.mockReturnValue({
      getSnapshot: () => ({ data: { status: "queued" } }),
      subscribe: () => () => {},
      close: vi.fn(),
    });
    const { result } = renderActions({ threads });

    await act(() => result.current.archive(threads.map((t) => t.id)));

    expect(mail.client.submitConversations).toHaveBeenCalledTimes(3);
    expect(mail.client.observeOperation).toHaveBeenCalledTimes(1);
    const lastCommandId =
      mail.client.submitConversations.mock.calls[2][0].commandId;
    expect(mail.client.observeOperation).toHaveBeenCalledWith({
      accountId: "account",
      operationId: lastCommandId,
    });

    mail.client.observeOperation.mockImplementation(() => {
      throw new Error("observe failed");
    });
    await act(async () => {
      await result.current.archive([threads[0].id]);
    });
    expect(notifications.error).not.toHaveBeenCalled();
    expect(toastUndo).toHaveBeenCalled();
  });

  it("restores trash and spam and toggles importance through the engine", async () => {
    const { result } = renderActions();
    await act(() => result.current.restoreFromTrash(["thread"]));
    await act(() => result.current.markNotSpam(["thread"]));
    await act(() => result.current.setImportantState(["thread"], true));

    expect(
      mail.client.submitConversations.mock.calls.map(([call]) => call.change),
    ).toEqual([
      { kind: "restore_from_trash" },
      { kind: "set_spam", spam: false },
      {
        kind: "set_membership",
        membership: "label",
        id: "IMPORTANT",
        present: true,
      },
    ]);
    expect(notifications.success).toHaveBeenLastCalledWith(
      "Marked as important",
    );
  });

  describe("a row standing for one message in two accounts", () => {
    // All inboxes shows the message once; reading, archiving and starring it
    // reach every copy, each in its own account, while the rest of the
    // actions stay with the copy shown.
    const row = {
      ...createThread(["INBOX", "UNREAD"], "shown"),
      account: { id: "one", email: "one@example.com", name: null, image: null },
      copies: [{ accountId: "two", threadId: "hidden" }],
    } as ListThread;

    function submitted() {
      return mail.client.submitConversations.mock.calls.map(([call]) => [
        call.accountId,
        call.conversations.map(
          (conversation: { conversationId: string }) =>
            conversation.conversationId,
        ),
        call.change.kind,
      ]);
    }

    it.each([
      ["archive", (actions: Actions) => actions.archive(["one:shown"])],
      ["read", (actions: Actions) => actions.setReadState(["one:shown"], true)],
      [
        "star",
        (actions: Actions) => actions.setStarredState(["one:shown"], true),
      ],
    ])("%s changes every copy, counted as one conversation", async (_, act_) => {
      const { result } = renderActions({ threads: [row] });
      let changed: string[] = [];
      await act(async () => {
        changed = await act_(result.current);
      });

      expect(submitted().map(([accountId, ids]) => [accountId, ids])).toEqual([
        ["one", ["shown"]],
        ["two", ["hidden"]],
      ]);
      expect(changed).toEqual(["one:shown"]);
      expect(notifications.error).not.toHaveBeenCalled();
    });

    it("says one conversation was archived, and its undo restores every copy", async () => {
      const { result } = renderActions({ threads: [row] });
      await act(() => result.current.archive(["one:shown"]));
      expect(toastUndo).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Archived" }),
      );

      let restored: string[] = [];
      await act(async () => {
        restored = await result.current.undo();
      });

      expect(restored).toEqual(["one:shown"]);
      expect(
        mail.client.cancelOperation.mock.calls.map(([call]) => call.accountId),
      ).toEqual(["one", "two"]);
      expect(notifications.success).toHaveBeenLastCalledWith("Restored");
    });

    // Each account's command registers its optimistic change before its
    // first await; were they sent one after another, the hidden copy would
    // show as its own row until the first account answered.
    it("hides every copy at once, so the other never shows alone", async () => {
      let admit = () => {};
      mail.client.submitConversations.mockReturnValue(
        new Promise((resolve) => {
          admit = () => resolve({ status: "queued" });
        }),
      );
      const { result } = renderActions({ threads: [row] });

      let archived: Promise<string[]> | undefined;
      act(() => {
        archived = result.current.archive(["one:shown"]);
      });

      expect(
        readOptimisticTriage(mail.client as unknown as MailClient)
          .map((entry) => entry.accountId)
          .sort(),
      ).toEqual(["one", "two"]);
      await act(async () => {
        admit();
        await archived;
      });
    });

    it("counts the row as failed when a copy's account refuses", async () => {
      mail.client.submitConversations.mockImplementation(
        async (command: { accountId: string }) =>
          command.accountId === "two"
            ? { status: "rejected", code: "stale_selection" }
            : { status: "queued" },
      );
      const { result } = renderActions({ threads: [row] });

      let archived: string[] = ["unset"];
      await act(async () => {
        archived = await result.current.archive(["one:shown"]);
      });

      expect(archived).toEqual([]);
      expect(toastUndo).not.toHaveBeenCalled();
      expect(notifications.error).toHaveBeenCalled();
    });

    it("keeps what one account changed undoable when another's submit throws", async () => {
      mail.client.submitConversations.mockImplementation(
        async (command: { accountId: string }) => {
          if (command.accountId === "two") throw new Error("engine gone");
          return { status: "queued" };
        },
      );
      const { result } = renderActions({ threads: [row] });

      let archived: string[] = ["unset"];
      await act(async () => {
        archived = await result.current.archive(["one:shown"]);
      });
      expect(archived).toEqual([]);
      expect(notifications.error).toHaveBeenCalled();

      mail.client.submitConversations.mockResolvedValue({ status: "queued" });
      let restored: string[] = [];
      await act(async () => {
        restored = await result.current.undo();
      });
      expect(restored).toEqual(["one:shown"]);
    });

    it("says it couldn't restore when a copy's undo fails", async () => {
      const { result } = renderActions({ threads: [row] });
      await act(() => result.current.archive(["one:shown"]));
      mail.client.cancelOperation.mockImplementation(
        async (call: { accountId: string }) => {
          if (call.accountId === "two") throw new Error("offline");
          return { status: "cancelled" };
        },
      );

      let restored: string[] = ["unset"];
      await act(async () => {
        restored = await result.current.undo();
      });

      expect(restored).toEqual([]);
      expect(notifications.error).toHaveBeenLastCalledWith("Couldn't restore");
    });

    it("deletes only the copy shown", async () => {
      const { result } = renderActions({ threads: [row] });
      await act(() => result.current.trash(["one:shown"]));

      expect(submitted()).toEqual([["one", ["shown"], "trash"]]);
    });
  });

  it("archives a multi-thread selection as one engine command", async () => {
    const threads = [
      createThread(["INBOX"], "one"),
      createThread(["INBOX"], "two"),
    ];
    const { result } = renderActions({ threads });
    let archived: string[] = [];
    await act(async () => {
      archived = await result.current.archive(threads.map((t) => t.id));
    });
    expect(archived).toHaveLength(2);
    expect(mail.client.submitConversations).toHaveBeenCalledTimes(1);
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: [
          { accountId: "account", conversationId: "one" },
          { accountId: "account", conversationId: "two" },
        ],
      }),
    );
  });

  it("submits one command per account for a combined inbox selection", async () => {
    const threads = [
      { ...createThread(["INBOX"], "shared"), account: { id: "work" } },
      { ...createThread(["INBOX"], "shared"), account: { id: "home" } },
    ] as unknown as ListThread[];
    const { result } = renderActions({ threads });
    let archived: string[] = [];
    await act(async () => {
      archived = await result.current.archive(["work:shared", "home:shared"]);
    });
    expect(archived).toEqual(["work:shared", "home:shared"]);
    expect(
      mail.client.submitConversations.mock.calls.map(([command]) => ({
        accountId: command.accountId,
        conversations: command.conversations,
      })),
    ).toEqual([
      {
        accountId: "work",
        conversations: [{ accountId: "work", conversationId: "shared" }],
      },
      {
        accountId: "home",
        conversations: [{ accountId: "home", conversationId: "shared" }],
      },
    ]);

    await act(() => result.current.undo());
    expect(
      mail.client.cancelOperation.mock.calls.map(([key]) => key.accountId),
    ).toEqual(["work", "home"]);
  });

  it("undoes an already-running multi-thread archive with one unarchive command", async () => {
    mail.client.cancelOperation.mockResolvedValue({ status: "too_late" });
    const threads = [
      createThread(["INBOX"], "one"),
      createThread(["INBOX"], "two"),
    ];
    const { result } = renderActions({ threads });
    await act(() => result.current.archive(threads.map((t) => t.id)));
    mail.client.submitConversations.mockClear();
    let restored: string[] = [];
    await act(async () => {
      restored = await result.current.undo();
    });
    expect(restored).toHaveLength(2);
    expect(mail.client.cancelOperation).toHaveBeenCalledTimes(1);
    expect(mail.client.submitConversations).toHaveBeenCalledTimes(1);
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        change: { kind: "unarchive" },
        conversations: [
          { accountId: "account", conversationId: "one" },
          { accountId: "account", conversationId: "two" },
        ],
      }),
    );
  });

  it("moves an archived thread to the inbox and undoes it by archiving again", async () => {
    mail.client.cancelOperation.mockResolvedValue({ status: "too_late" });
    const { result } = renderActions({ threads: [createThread(["SENT"])] });
    await act(() => result.current.moveToInbox(["thread"]));
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({ change: { kind: "unarchive" } }),
    );
    mail.client.submitConversations.mockClear();
    await act(() => result.current.undo());
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({ change: { kind: "archive" } }),
    );
  });

  it("does not archive a missing row", async () => {
    const { result } = renderActions({ threads: [] });
    await act(() => result.current.archive(["missing-thread"]));
    expect(mail.client.submitConversations).not.toHaveBeenCalled();
    expect(notifications.error).toHaveBeenCalledWith(
      "Couldn't queue archiving",
    );
  });

  it("says mail is still starting when the engine isn't ready yet", async () => {
    mail.started = false;
    const { result } = renderActions();
    await act(() => result.current.archive(["thread"]));
    expect(notifications.error).toHaveBeenCalledWith(
      "Mail is still starting. Try again in a moment.",
    );
  });

  it("explains a full command queue instead of a generic archive failure", async () => {
    mail.client.submitConversations.mockResolvedValue({
      status: "rejected",
      code: "queue_full",
    });
    const { result } = renderActions();
    await act(() => result.current.archive(["thread"]));
    expect(notifications.error).toHaveBeenCalledWith(
      admissionRejectionCopy("queue_full"),
    );
  });

  it("cancels an in-flight archive on undo", async () => {
    const { result } = renderActions();
    await act(() => result.current.archive(["thread"]));
    await act(() => result.current.undo());
    expect(mail.client.cancelOperation).toHaveBeenCalledWith({
      accountId: "account",
      operationId: expect.any(String),
    });
  });

  // The row leaves on the keypress, before the engine admits the command, so
  // a quick `z` must reach this archive rather than be lost or undo the last.
  it("undoes an archive whose command is still being admitted", async () => {
    const threads = [
      createThread(["INBOX"], "one"),
      createThread(["INBOX"], "two"),
    ];
    const { result } = renderActions({ threads });
    await act(() => result.current.archive(["one"]));
    const firstCommandId =
      mail.client.submitConversations.mock.calls[0][0].commandId;
    mail.client.cancelOperation.mockClear();

    let admit: (value: { status: "queued" }) => void = () => {};
    mail.client.submitConversations.mockReturnValueOnce(
      new Promise((resolve) => {
        admit = resolve;
      }),
    );
    let restored: string[] = [];
    await act(async () => {
      const archiving = result.current.archive(["two"]);
      const undoing = result.current.undo();
      admit({ status: "queued" });
      await archiving;
      restored = await undoing;
    });

    const secondCommandId =
      mail.client.submitConversations.mock.calls[1][0].commandId;
    expect(restored).toEqual(["two"]);
    expect(mail.client.cancelOperation).toHaveBeenCalledTimes(1);
    expect(mail.client.cancelOperation).toHaveBeenCalledWith({
      accountId: "account",
      operationId: secondCommandId,
    });
    expect(secondCommandId).not.toBe(firstCommandId);
  });

  it("keeps a newer archive as the one to undo when an older undo fails", async () => {
    const threads = [
      createThread(["INBOX"], "one"),
      createThread(["INBOX"], "two"),
    ];
    const { result } = renderActions({ threads });
    await act(() => result.current.archive(["one"]));

    let answerCancel: (value: { status: "too_late" }) => void = () => {};
    mail.client.cancelOperation.mockReturnValueOnce(
      new Promise((resolve) => {
        answerCancel = resolve;
      }),
    );
    mail.client.submitConversations
      .mockResolvedValueOnce({ status: "queued" })
      .mockResolvedValueOnce({ status: "rejected", code: "queue_full" });
    await act(async () => {
      const undoingFirst = result.current.undo();
      await result.current.archive(["two"]);
      answerCancel({ status: "too_late" });
      await undoingFirst;
    });
    const secondCommandId =
      mail.client.submitConversations.mock.calls[1][0].commandId;

    mail.client.cancelOperation.mockClear();
    await act(() => result.current.undo());
    expect(mail.client.cancelOperation).toHaveBeenCalledWith({
      accountId: "account",
      operationId: secondCommandId,
    });
  });

  // Today lists conversations from the server, not the engine's views, so it
  // needs to hear which rows an undo brought back.
  it("still undoes an archive after switching account, on the engine now running", async () => {
    const closedClient = mail.client;
    const { result, rerender } = renderHook(
      ({ emailAccountId, threads }) =>
        useThreadActions({ emailAccountId, threads }),
      {
        initialProps: {
          emailAccountId: "account-a",
          threads: [createThread(["INBOX"], "thread")],
        },
      },
    );
    await act(() => result.current.archive(["thread"]));

    // Switching account replaces the engine the archive was queued on.
    const nextClient = {
      cancelOperation: vi.fn().mockResolvedValue({ status: "cancelled" }),
      getDiagnostics: vi.fn(),
      submitConversations: vi.fn(),
    };
    mail.client = nextClient;
    try {
      rerender({ emailAccountId: "account-b", threads: [] });

      let restored: string[] = [];
      await act(async () => {
        restored = await result.current.undo();
      });
      expect(restored).toEqual(["thread"]);
      expect(nextClient.cancelOperation).toHaveBeenCalledWith({
        accountId: "account-a",
        operationId: expect.any(String),
      });
      expect(closedClient.cancelOperation).not.toHaveBeenCalled();
    } finally {
      mail.client = closedClient;
    }
  });

  it("lets the toast from before an account switch undo on the engine now running", async () => {
    const closedClient = mail.client;
    const { result, rerender } = renderHook(
      ({ emailAccountId, threads }) =>
        useThreadActions({ emailAccountId, threads }),
      {
        initialProps: {
          emailAccountId: "account-a",
          threads: [createThread(["INBOX"], "thread")],
        },
      },
    );
    await act(() => result.current.archive(["thread"]));
    const onUndo = vi.mocked(toastUndo).mock.calls[0]?.[0].onUndo;
    const nextClient = {
      cancelOperation: vi.fn().mockResolvedValue({ status: "cancelled" }),
      getDiagnostics: vi.fn(),
      submitConversations: vi.fn(),
    };
    mail.client = nextClient;
    try {
      rerender({ emailAccountId: "account-b", threads: [] });

      await act(async () => {
        await onUndo?.();
      });
      expect(nextClient.cancelOperation).toHaveBeenCalledOnce();
      expect(closedClient.cancelOperation).not.toHaveBeenCalled();
    } finally {
      mail.client = closedClient;
    }
  });

  describe("moving to an Outlook folder", () => {
    beforeEach(() => {
      // An inbox conversation with a reply from Sent and one message the
      // user had already filed elsewhere.
      mail.client.observeConversation.mockReturnValue(
        conversationHandle([
          message("from-inbox", "inbox-folder", ["inbox"]),
          message("from-sent", "sent-folder", ["sent"]),
          message("from-receipts", "receipts-folder", []),
        ]),
      );
    });

    it("moves the conversation with the engine's move change", async () => {
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      expect(mail.client.submitConversations).toHaveBeenCalledWith(
        expect.objectContaining({
          conversations: [{ accountId: "account", conversationId: "thread" }],
          change: { kind: "move", folderId: "projects-folder" },
        }),
      );
      expect(toastUndo).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Moved to Projects" }),
      );
    });

    it("reads where each message is before moving it", async () => {
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      expect(mail.client.observeConversation).toHaveBeenCalledWith(
        { accountId: "account", conversationId: "thread" },
        expect.anything(),
      );
      expect(
        mail.client.observeConversation.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mail.client.submitConversations.mock.invocationCallOrder[0],
      );
    });

    it("undoes a move already sent by returning each message to where it came from", async () => {
      mail.client.cancelOperation.mockResolvedValue({ status: "too_late" });
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      let restored: string[] = [];
      await act(async () => {
        restored = await result.current.undo();
      });

      expect(restored).toEqual(["thread"]);
      const moves = mail.client.submitMetadata.mock.calls.map(([command]) => ({
        change: command.change,
        messageIds: command.targets.map(
          (target: { messageId: string }) => target.messageId,
        ),
      }));
      expect(moves).toEqual(
        expect.arrayContaining([
          { change: { kind: "unarchive" }, messageIds: ["from-inbox"] },
          {
            change: { kind: "move", folderId: "sent-folder" },
            messageIds: ["from-sent"],
          },
          {
            change: { kind: "move", folderId: "receipts-folder" },
            messageIds: ["from-receipts"],
          },
        ]),
      );
      expect(moves).toHaveLength(3);
    });

    it("cancels a move not yet sent rather than moving anything back", async () => {
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      await act(() => result.current.undo());
      expect(mail.client.cancelOperation).toHaveBeenCalled();
      expect(mail.client.submitMetadata).not.toHaveBeenCalled();
    });

    it("has the whole conversation stored before reading where its messages are", async () => {
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      expect(mail.client.ensureConversationMessages).toHaveBeenCalledWith({
        accountId: "account",
        conversationId: "thread",
      });
      expect(
        mail.client.ensureConversationMessages.mock.invocationCallOrder[0],
      ).toBeLessThan(
        mail.client.observeConversation.mock.invocationCallOrder[0],
      );
    });

    it("doesn't move a conversation it can't fully fetch, whose missing messages undo couldn't return", async () => {
      mail.client.ensureConversationMessages.mockResolvedValue({
        status: "unavailable",
      });
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      expect(mail.client.submitConversations).not.toHaveBeenCalled();
      expect(notifications.error).toHaveBeenCalledWith(
        "Couldn't queue moving to Projects",
      );
    });

    it("returns moved messages it never saw to where most of the conversation came from", async () => {
      mail.client.cancelOperation.mockResolvedValue({ status: "too_late" });
      mail.client.observeConversation.mockReturnValue(
        conversationHandle([message("seen", "inbox-folder", ["inbox"])]),
      );
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      // By undo time the move has also taken a message stored after the read.
      mail.client.observeConversation.mockReturnValue(
        conversationHandle([
          message("seen", "projects-folder", []),
          message("late", "projects-folder", []),
        ]),
      );
      await act(() => result.current.undo());

      expect(mail.client.submitMetadata).toHaveBeenCalledTimes(1);
      expect(mail.client.submitMetadata).toHaveBeenCalledWith(
        expect.objectContaining({
          change: { kind: "unarchive" },
          targets: [
            { accountId: "account", messageId: "seen" },
            { accountId: "account", messageId: "late" },
          ],
        }),
      );
    });

    it("counts a conversation restored only when every message went back, and lets a failed undo be retried", async () => {
      mail.client.cancelOperation.mockResolvedValue({ status: "too_late" });
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      mail.client.submitMetadata
        .mockResolvedValueOnce({ status: "queued" })
        .mockResolvedValueOnce({ status: "rejected", code: "queue_full" });
      let restored: string[] = [];
      await act(async () => {
        restored = await result.current.undo();
      });
      expect(restored).toEqual([]);
      expect(mail.client.submitMetadata).toHaveBeenCalledTimes(3);
      expect(notifications.error).toHaveBeenCalledWith("Couldn't restore");

      await act(async () => {
        restored = await result.current.undo();
      });
      expect(restored).toEqual(["thread"]);
    });

    it("doesn't move mail whose folders it couldn't read, which undo couldn't put back", async () => {
      mail.client.observeConversation.mockReturnValue(
        conversationHandle(null, "error"),
      );
      const { result } = renderActions();
      await act(() =>
        result.current.moveToFolder(["thread"], {
          folderId: "projects-folder",
          name: "Projects",
        }),
      );
      expect(mail.client.submitConversations).not.toHaveBeenCalled();
      expect(notifications.error).toHaveBeenCalledWith(
        "Couldn't queue moving to Projects",
      );
    });
  });

  it("acts on a conversation listed outside the mailbox and reports what undo restored", async () => {
    const onRestored = vi.fn();
    const { result } = renderHook(() =>
      useThreadActions({
        emailAccountId: "account",
        threads: [{ id: "today-thread", messageIds: ["today-message"] }],
        onRestored,
      }),
    );
    await act(() => result.current.archive(["today-thread"]));
    expect(mail.client.submitConversations).toHaveBeenCalledWith(
      expect.objectContaining({
        conversations: [
          { accountId: "account", conversationId: "today-thread" },
        ],
      }),
    );
    await act(() => result.current.undo());
    expect(onRestored).toHaveBeenCalledWith(["today-thread"]);
  });
});

type Actions = ReturnType<typeof useThreadActions>;

function renderActions({
  threads = [createThread(["INBOX", "UNREAD"])],
}: {
  threads?: ListThread[];
} = {}) {
  return renderHook(() =>
    useThreadActions({
      emailAccountId: "account",
      threads,
    }),
  );
}

function createThread(labelIds: string[], id = "thread"): ListThread {
  return {
    id,
    messageIds: [`${id}-message`],
    snippet: "snippet",
    plan: undefined,
    plans: [],
    messages: [
      {
        id: `${id}-message`,
        threadId: id,
        snippet: "snippet",
        subject: "Subject",
        date: "0",
        internalDate: "0",
        labelIds,
        headers: { subject: "Subject" },
      },
    ],
  };
}

function conversationHandle(
  messages: ReturnType<typeof message>[] | null,
  status: "ready" | "error" = "ready",
) {
  return {
    getSnapshot: () => ({
      status,
      revision: null,
      refreshing: false,
      error: status === "error" ? { code: "boom", retryable: true } : null,
      data: messages
        ? {
            key: { accountId: "account", conversationId: "thread" },
            messages,
            nextPage: null,
            coverage: [],
          }
        : null,
    }),
    subscribe: () => () => {},
    close: vi.fn(),
  };
}

function message(messageId: string, folderId: string, roles: string[]) {
  return {
    key: { accountId: "account", messageId },
    metadata: { folderId, roles },
    content: { status: "not_requested" },
    pendingOperationIds: [],
  };
}
