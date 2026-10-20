// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ListThread } from "./types";
import { useThreadActions } from "./use-thread-actions";
import { toastUndo } from "@/components/Toast";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";

const notifications = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));
const mail = vi.hoisted(() => ({
  started: true,
  client: {
    cancelOperation: vi.fn(),
    getDiagnostics: vi.fn(),
    observeOperation: vi.fn(),
    submitConversations: vi.fn(),
  },
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
