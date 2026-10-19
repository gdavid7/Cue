import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import {
  dismissReplySuggestionAction,
  recordReplySuggestionStageAction,
  recordSuggestedReplyDraftAction,
  saveSuggestedReplyAction,
} from "@/utils/actions/thread-assist";
import type { ParsedMessage } from "@/utils/types";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));

const mocks = vi.hoisted(() => ({
  createEmailProvider: vi.fn(),
}));
vi.mock("@/utils/email/provider", () => ({
  createEmailProvider: mocks.createEmailProvider,
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  getSuggestedReplySettings: async () => SUGGESTION_SETTINGS,
}));
vi.mock("@/utils/user/own-addresses", () => ({
  getUserOwnAddresses: async () => ["user@example.com", "me@gmail.com"],
}));
vi.mock("@/utils/email/reply-body", () => ({
  buildDraftReplyBody: async ({ text }: { text: string }) => text,
}));

const EMAIL_ACCOUNT_ID = "email-account-1";

describe("saveSuggestedReplyAction", () => {
  let mailbox: ReturnType<typeof createMailbox>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }),
    );
    mailbox = createMailbox();
    mocks.createEmailProvider.mockResolvedValue(mailbox.provider);
  });

  // D5: the user's other connected mailbox is never copied on the reply.
  it("tells the mailbox every connected address of the user", async () => {
    await saveSuggestedReplyAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      content: "Wednesday works.",
    });

    expect(mailbox.ownEmailsSeen).toEqual([
      ["user@example.com", "user@example.com", "me@gmail.com"],
    ]);
  });

  it("leaves one reply draft in the conversation when saved twice", async () => {
    const first = await saveSuggestedReplyAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      content: "Wednesday works.",
    });
    const second = await saveSuggestedReplyAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      content: "Wednesday at 3 works.",
    });

    expect(second?.data?.draftId).toBe(first?.data?.draftId);
    expect(mailbox.drafts).toHaveLength(1);
    expect(mailbox.drafts[0].html).toContain("Wednesday at 3 works.");
    expect(mailbox.drafts[0].html).not.toContain("Wednesday works.");
  });

  // RD-3: the browser kept the suggestion, so it sends Cue's original text.
  it("remembers the suggestion as Cue wrote it, not as the user edited it", async () => {
    const result = await saveSuggestedReplyAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      content: "Wednesday at 3 works.",
      suggested: "Wednesday works.",
    });

    expect(prisma.suggestedReplyDraft.upsert).toHaveBeenCalledWith({
      where: {
        emailAccountId_draftId: {
          emailAccountId: EMAIL_ACCOUNT_ID,
          draftId: result?.data?.draftId,
        },
      },
      create: {
        emailAccountId: EMAIL_ACCOUNT_ID,
        threadId: "thread-1",
        messageId: "m1",
        draftId: result?.data?.draftId,
        content: "Wednesday works.",
      },
      update: { messageId: "m1", content: "Wednesday works." },
    });
  });

  it("saves the draft without remembering it when the suggestion is gone", async () => {
    const result = await saveSuggestedReplyAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      content: "Wednesday at 3 works.",
    });

    expect(result?.data?.draftId).toBe("draft-1");
    expect(prisma.suggestedReplyDraft.upsert).not.toHaveBeenCalled();
  });
});

// The reader's first edit of a suggestion made it a mailbox draft.
describe("recordSuggestedReplyDraftAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }),
    );
  });

  // The rule's text comes from the database, so the browser can't pass off
  // other text as Cue's.
  it("remembers a rule's suggestion by its stored text and links it", async () => {
    prisma.executedAction.findFirst.mockResolvedValue({
      id: "suggestion-1",
      content: "Thursday works for me.",
    } as never);

    await recordSuggestedReplyDraftAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      messageId: "m1",
      draftId: "draft-9",
      executedActionId: "suggestion-1",
      suggested: "Something else entirely.",
    });

    expect(prisma.executedAction.findFirst).toHaveBeenCalledWith({
      where: {
        id: "suggestion-1",
        type: "DRAFT_EMAIL",
        draftId: null,
        executedRule: {
          emailAccountId: EMAIL_ACCOUNT_ID,
          threadId: "thread-1",
        },
      },
      select: { id: true, content: true },
    });
    expect(prisma.suggestedReplyDraft.upsert).toHaveBeenCalledWith({
      where: {
        emailAccountId_draftId: {
          emailAccountId: EMAIL_ACCOUNT_ID,
          draftId: "draft-9",
        },
      },
      create: {
        emailAccountId: EMAIL_ACCOUNT_ID,
        threadId: "thread-1",
        messageId: "m1",
        draftId: "draft-9",
        content: "Thursday works for me.",
        executedActionId: "suggestion-1",
      },
      update: {
        messageId: "m1",
        content: "Thursday works for me.",
        executedActionId: "suggestion-1",
      },
    });
    // A suggestion belongs to one draft: an older record lets go of it first,
    // in the same batch, so the unique link can't conflict.
    expect(prisma.suggestedReplyDraft.updateMany).toHaveBeenCalledWith({
      where: {
        executedActionId: "suggestion-1",
        NOT: { emailAccountId: EMAIL_ACCOUNT_ID, draftId: "draft-9" },
      },
      data: { executedActionId: null },
    });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(vi.mocked(prisma.$transaction).mock.calls[0][0]).toHaveLength(2);
  });

  it("remembers a suggestion this browser kept by its text", async () => {
    await recordSuggestedReplyDraftAction(EMAIL_ACCOUNT_ID, {
      threadId: "thread-1",
      messageId: "m1",
      draftId: "draft-9",
      suggested: "Wednesday works.",
    });

    expect(prisma.executedAction.findFirst).not.toHaveBeenCalled();
    expect(prisma.suggestedReplyDraft.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          content: "Wednesday works.",
          executedActionId: undefined,
        }),
      }),
    );
  });
});

describe("dismissReplySuggestionAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.executedAction.updateMany.mockResolvedValue({ count: 1 });
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }),
    );
  });

  it("dismisses only this account's waiting suggestion", async () => {
    await dismissReplySuggestionAction(EMAIL_ACCOUNT_ID, {
      executedActionId: "suggestion-1",
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "suggestion-1",
        type: "DRAFT_EMAIL",
        draftId: null,
        draftStatus: "PENDING",
        executedRule: { emailAccountId: EMAIL_ACCOUNT_ID },
      },
      data: { draftStatus: "DISMISSED" },
    });
    expect(mocks.createEmailProvider).not.toHaveBeenCalled();
  });
});

describe("recordReplySuggestionStageAction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    prisma.executedAction.updateMany.mockResolvedValue({ count: 1 });
    vi.useFakeTimers({ now: new Date("2026-10-19T12:00:00Z") });
    prisma.emailAccount.findUnique.mockResolvedValue(
      getMockEmailAccountWithAccount({
        email: "user@example.com",
        userId: "user-1",
      }),
    );
  });

  // Counted once: showing the same suggestion again keeps the first time.
  it.each([
    ["shown", "replySuggestionShownAt"],
    ["opened", "replySuggestionOpenedAt"],
  ] as const)("records when this account's suggestion was first %s", async (stage, field) => {
    await recordReplySuggestionStageAction(EMAIL_ACCOUNT_ID, {
      executedActionId: "suggestion-1",
      stage,
    });

    expect(prisma.executedAction.updateMany).toHaveBeenCalledWith({
      where: {
        id: "suggestion-1",
        type: "DRAFT_EMAIL",
        draftId: null,
        executedRule: { emailAccountId: EMAIL_ACCOUNT_ID },
        [field]: null,
      },
      data: { [field]: new Date("2026-10-19T12:00:00Z") },
    });
    vi.useRealTimers();
  });

  it("refuses a stage the reader doesn't record", async () => {
    const result = await recordReplySuggestionStageAction(EMAIL_ACCOUNT_ID, {
      executedActionId: "suggestion-1",
      stage: "sent" as never,
    });

    expect(result?.validationErrors).toBeDefined();
    expect(prisma.executedAction.updateMany).not.toHaveBeenCalled();
    vi.useRealTimers();
  });
});

// A provider that keeps drafts in the thread the way Gmail and Outlook do.
function createMailbox() {
  const received = {
    id: "m1",
    threadId: "thread-1",
    labelIds: ["INBOX"],
    headers: {
      from: "Kevin <kevin@example.com>",
      to: "user@example.com",
      subject: "Meet Wednesday?",
      date: "Mon, 1 Jan 2024 10:00:00 +0000",
      "message-id": "<m1@example.com>",
    },
    textPlain: "Meet Wednesday?",
  } as unknown as ParsedMessage;
  const drafts: { id: string; messageId: string; html: string }[] = [];
  const ownEmailsSeen: (string | string[])[] = [];
  const draftMessage = (draft: (typeof drafts)[number]) =>
    ({
      ...received,
      id: draft.messageId,
      labelIds: ["DRAFT"],
      headers: { ...received.headers, from: "user@example.com" },
    }) as ParsedMessage;

  const provider = {
    getThread: async (
      _threadId: string,
      options?: { includeDrafts?: boolean },
    ) => ({
      id: "thread-1",
      snippet: "",
      messages: [
        received,
        ...(options?.includeDrafts ? drafts.map(draftMessage) : []),
      ],
    }),
    getDraftReferenceForMessage: async (messageId: string) => {
      const draft = drafts.find((d) => d.messageId === messageId);
      return draft ? { id: draft.id } : null;
    },
    draftEmail: async (
      _email: ParsedMessage,
      args: { content: string },
      userEmails: string | string[],
    ) => {
      ownEmailsSeen.push(userEmails);
      const draft = {
        id: `draft-${drafts.length + 1}`,
        messageId: `draft-message-${drafts.length + 1}`,
        html: args.content,
      };
      drafts.push(draft);
      return { draftId: draft.id };
    },
    updateDraft: async (draftId: string, params: { messageHtml?: string }) => {
      const draft = drafts.find((d) => d.id === draftId);
      if (!draft) throw new Error("Draft not found");
      draft.html = params.messageHtml ?? draft.html;
    },
  };
  return { provider, drafts, ownEmailsSeen };
}

const SUGGESTION_SETTINGS = {
  draftReplies: "on" as const,
  webLookupEnabled: true,
};
