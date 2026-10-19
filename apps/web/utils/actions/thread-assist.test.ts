import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockEmailAccountWithAccount } from "@/__tests__/helpers";
import prisma from "@/utils/__mocks__/prisma";
import { saveSuggestedReplyAction } from "@/utils/actions/thread-assist";
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
  draftRepliesEnabled: true,
  webLookupEnabled: true,
};
