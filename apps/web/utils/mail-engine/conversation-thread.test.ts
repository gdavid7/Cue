import { describe, expect, it, vi } from "vitest";
import type { ConversationView } from "@inboxzero/mail-core/ports/mail-store";
import type { MessageAttachmentDescriptor } from "@inboxzero/mail-core/messages";
import {
  conversationViewToThreadResponse,
  requestMissingMessageContent,
} from "./conversation-thread";

describe("conversationViewToThreadResponse", () => {
  it("projects engine messages onto the reader thread shape", () => {
    const thread = conversationViewToThreadResponse(view());
    expect(thread.thread.id).toBe("c-1");
    expect(thread.thread.messages[0]).toMatchObject({
      id: "m-1",
      threadId: "c-1",
      subject: "Hello",
      textPlain: "Hi there",
      externalUrl: "https://outlook.office.com/mail/deeplink/read/m-1",
      labelIds: ["INBOX", "UNREAD"],
      headers: { from: "Ada <ada@example.com>" },
    });
  });

  it("writes the Date header in the sender's offset when it is known", () => {
    const known = message();
    known.metadata.senderUtcOffsetMinutes = 60;
    const [withOffset, withoutOffset] = conversationViewToThreadResponse(
      view({ messages: [known, message({ messageId: "m-2" })] }),
    ).thread.messages;
    expect(withOffset.headers.date).toBe("2023-11-14T23:13:20.000+01:00");
    expect(Date.parse(withOffset.headers.date)).toBe(1_700_000_000_000);
    expect(withoutOffset.headers.date).toBe("2023-11-14T22:13:20.000Z");
  });

  it("gives the reader each message's Reply-To, and none for rows stored without it", () => {
    const withReplyTo = message();
    withReplyTo.metadata.replyTo = [
      "Billing <billing@pay.example>",
      "ops@pay.example",
    ];
    const [replied, old] = conversationViewToThreadResponse(
      view({ messages: [withReplyTo, message({ messageId: "m-2" })] }),
    ).thread.messages;
    expect(replied.headers["reply-to"]).toBe(
      "Billing <billing@pay.example>, ops@pay.example",
    );
    expect(old.headers["reply-to"]).toBeUndefined();
  });

  it("projects stored attachments and meeting invitations onto the reader", () => {
    const thread = conversationViewToThreadResponse(
      view({
        messages: [
          message({
            attachments: [
              {
                attachmentId: "att-1",
                filename: "reader-preview.png",
                mimeType: "image/png",
                size: 12,
                inline: false,
              },
            ],
            isMeetingInvitation: true,
          }),
        ],
      }),
    );
    expect(thread.thread.messages[0]?.attachments).toEqual([
      expect.objectContaining({
        attachmentId: "att-1",
        filename: "reader-preview.png",
        mimeType: "image/png",
        size: 12,
      }),
    ]);
    expect(thread.thread.messages[0]?.isMeetingInvitation).toBe(true);
  });

  it("hides draft messages unless includeDrafts is set", () => {
    const draftView = view({
      messages: [
        message({
          messageId: "m-draft",
          roles: ["draft"],
          read: true,
        }),
        message(),
      ],
    });
    expect(
      conversationViewToThreadResponse(draftView).thread.messages.map(
        (item) => item.id,
      ),
    ).toEqual(["m-1"]);
    expect(
      conversationViewToThreadResponse(draftView, {
        includeDrafts: true,
      }).thread.messages.map((item) => item.id),
    ).toEqual(["m-draft", "m-1"]);
  });

  it("preserves actual inline IDs through storage and reader projection without inventing IDs", () => {
    const thread = conversationViewToThreadResponse(
      view({
        messages: [
          message({
            attachments: [
              {
                attachmentId: "gmail-part:0.1",
                filename: "different-name.png",
                mimeType: "image/png",
                size: 4,
                inline: true,
                contentId: "logo@example.test",
              },
              {
                attachmentId: "inline-missing",
                filename: "not-a-cid.png",
                mimeType: "image/png",
                size: 4,
                inline: true,
                contentId: null,
              },
            ],
          }),
        ],
      }),
    );
    expect(
      thread.thread.messages[0].inline.map(
        (attachment) => attachment.headers["content-id"],
      ),
    ).toEqual(["logo@example.test", ""]);
  });
});

describe("requestMissingMessageContent", () => {
  it("requests each missing body once and retries one the engine rejected", async () => {
    const ensureMessageContent = vi
      .fn()
      .mockResolvedValueOnce({ status: "rejected", code: "queue_full" })
      .mockResolvedValue({ status: "scheduled" });
    const requested = new Set<string>();
    const missing = view({
      messages: [{ ...message(), content: { status: "not_requested" } }],
    });

    requestMissingMessageContent({ ensureMessageContent }, missing, requested);
    await vi.waitFor(() => expect(requested.size).toBe(0));
    requestMissingMessageContent({ ensureMessageContent }, missing, requested);
    requestMissingMessageContent({ ensureMessageContent }, missing, requested);

    expect(ensureMessageContent).toHaveBeenCalledTimes(2);
  });
});

function view(overrides: Partial<ConversationView> = {}): ConversationView {
  return {
    key: { accountId: "acc-1", conversationId: "c-1" },
    messages: [message()],
    nextPage: null,
    coverage: [],
    ...overrides,
  };
}

function message(
  overrides: {
    messageId?: string;
    roles?: Array<"inbox" | "sent" | "draft" | "trash" | "spam">;
    read?: boolean;
    externalUrl?: string;
    attachments?: MessageAttachmentDescriptor[];
    isMeetingInvitation?: boolean;
  } = {},
): ConversationView["messages"][number] {
  return {
    key: {
      accountId: "acc-1",
      messageId: overrides.messageId ?? "m-1",
    },
    metadata: {
      subject: "Hello",
      preview: "Hi there",
      externalUrl:
        overrides.externalUrl ??
        "https://outlook.office.com/mail/deeplink/read/m-1",
      from: "Ada <ada@example.com>",
      to: ["user@example.com"],
      cc: [],
      receivedAtMs: 1_700_000_000_000,
      read: overrides.read ?? false,
      starred: false,
      folderId: null,
      labelIds: [],
      categoryIds: [],
      roles: overrides.roles ?? ["inbox"],
      hasAttachments: Boolean(overrides.attachments?.length),
    },
    content: {
      status: "available",
      html: null,
      text: "Hi there",
      attachments: overrides.attachments ?? [],
      isMeetingInvitation: overrides.isMeetingInvitation ?? false,
    },
    pendingOperationIds: [],
  };
}
