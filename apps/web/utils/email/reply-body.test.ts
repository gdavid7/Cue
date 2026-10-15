import type { gmail_v1 } from "@googleapis/gmail";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { buildDraftReplyBody } from "@/utils/email/reply-body";
import { draftEmail } from "@/utils/gmail/mail";

vi.mock("@/utils/prisma");

// The reply drafter asks the model for plain text with markdown links. What
// matters is what the recipient of the saved draft sees.
const MODEL_DRAFT =
  "Thanks! Pick a slot on [my calendar](https://cal.example.com/ada).\n\nAda";

describe("markdown links in an automatic draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("reach the recipient as a link, not markdown, when labels may hide URLs", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      allowHiddenAiDraftLinks: true,
      signature: null,
    } as never);

    const { html, text } = await saveDraft(MODEL_DRAFT);

    expect(html).toContain(
      '<a href="https://cal.example.com/ada">my calendar</a>',
    );
    expect(text).toContain("my calendar [https://cal.example.com/ada]");
    expect(`${html}${text}`).not.toContain("](");
  });

  it("show the address instead of the label by default", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      allowHiddenAiDraftLinks: false,
      signature: null,
    } as never);

    const { html, text } = await saveDraft(MODEL_DRAFT);

    expect(html).toContain("https://cal.example.com/ada");
    expect(text).toContain("https://cal.example.com/ada");
    expect(`${html}${text}`).not.toContain("](");
  });
});

async function saveDraft(modelText: string) {
  const body = await buildDraftReplyBody({
    emailAccountId: "account-1",
    text: modelText,
  });
  const create = vi.fn().mockResolvedValue({ data: { id: "draft-1" } });
  const gmail = {
    users: { drafts: { create } },
  } as unknown as gmail_v1.Gmail;

  await draftEmail(
    gmail,
    {
      attachments: [],
      headers: {
        date: "Mon, 6 Oct 2026 10:00:00 +0000",
        from: "Grace <grace@example.com>",
        "message-id": "<original@example.com>",
        subject: "Meeting",
        to: "ada@example.com",
      },
      id: "message-1",
      internalDate: "1791280800000",
      snippet: "",
      textHtml: "<p>Can we meet?</p>",
      textPlain: "Can we meet?",
      threadId: "thread-1",
    },
    { content: body },
    "ada@example.com",
  );

  const raw = create.mock.calls[0][0].requestBody.message.raw as string;
  const email = await PostalMime.parse(Buffer.from(raw, "base64url"));
  return { html: email.html ?? "", text: email.text ?? "" };
}
