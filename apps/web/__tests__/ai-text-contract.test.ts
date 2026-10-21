// @vitest-environment jsdom

import type { gmail_v1 } from "@googleapis/gmail";
import {
  combineEmailHtml,
  finalizeEditableEmailHtml,
  prepareEmailDraft,
} from "@inboxzero/email-editor/core";
import { markdownToEmailHtml } from "@inboxzero/email-editor/markdown";
import PostalMime from "postal-mime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMockMessage } from "@/__tests__/helpers";
import {
  draftHtmlToReplyText,
  withSuggestionEscapesRepaired,
} from "@/components/email-list/reply-assist";
import { ExecutedRuleStatus, SystemType } from "@/generated/prisma/enums";
import prisma from "@/utils/__mocks__/prisma";
import type { RunRulesResult } from "@/utils/ai/choose-rule/run-rules";
import { setBrowserCacheUser } from "@/utils/browser-cache";
import {
  buildDraftReplyBody,
  withoutDraftReplySignature,
} from "@/utils/email/reply-body";
import { renderEmailTextWithSafeLinks } from "@/utils/email/render-safe-links";
import type { EmailProvider } from "@/utils/email/types";
import { draftEmail } from "@/utils/gmail/mail";
import { createScopedLogger } from "@/utils/logger";
import { predraftReply } from "@/utils/reply-tracker/predraft-reply";
import { textToHtmlParagraphs } from "@/utils/string";
import {
  keptSuggestionFor,
  keptSuggestions,
  suggestionKey,
} from "@/utils/thread-context/suggested-reply-store";

vi.mock("@/utils/prisma");
vi.mock("@/env", () => ({
  env: {
    REDIS_HTTP_URL: "https://redis.example.com",
    REDIS_HTTP_TOKEN: "token",
  },
}));

const { suggestReply, getSuggestedReplySettings } = vi.hoisted(() => ({
  suggestReply: vi.fn(),
  getSuggestedReplySettings: vi.fn(),
}));
vi.mock("@/utils/redis", () => ({
  redis: {
    eval: vi.fn(async () => 1),
    set: vi.fn(async () => "OK"),
  },
}));
vi.mock("@/utils/thread-context/suggest-reply", () => ({
  suggestReply,
  getSuggestedReplySettings,
}));

/**
 * DR-6 double-escaped AI text on its way to the composer and was caught in
 * production, not by a test. Every way AI-written text reaches the composer
 * and then the outgoing mail is driven here with punctuation that escaping
 * mangles, and what the recipient reads must be exactly what the model wrote.
 * A new path that puts AI text in front of the composer belongs in `PATHS`.
 */
const TEXT = `I'm "quoted" & <bracketed> it's 5 > 3`;
const EMAIL_ACCOUNT_ID = "account-1";
const SIGNATURE = "<div>Sam</div>";

type AiTextPath = {
  name: string;
  /** The composer's body as it opens, which Send then sends. */
  opensWith: () => string | Promise<string>;
};

const PATHS: AiTextPath[] = [
  {
    name: "a rule's DRAFT_EMAIL suggestion, stored as HTML and shown in the reader",
    opensWith: async () => {
      const stored = await storedRuleBody({ allowHiddenAiDraftLinks: false });
      return textToHtmlParagraphs(draftHtmlToReplyText(stored));
    },
  },
  {
    name: "a rule's suggestion whose labels may hide links",
    opensWith: async () => {
      const stored = await storedRuleBody({ allowHiddenAiDraftLinks: true });
      return textToHtmlParagraphs(draftHtmlToReplyText(stored));
    },
  },
  {
    name: "a rule's suggestion with the account's signature after it",
    opensWith: async () => {
      const stored = await storedRuleBody({
        allowHiddenAiDraftLinks: false,
        signature: SIGNATURE,
      });
      return textToHtmlParagraphs(
        draftHtmlToReplyText(withoutDraftReplySignature(stored, SIGNATURE)),
      );
    },
  },
  {
    name: "a DR-3 pre-draft, driven through predraftReply",
    opensWith: async () => {
      const stored = await predraftedBody();
      return textToHtmlParagraphs(draftHtmlToReplyText(stored));
    },
  },
  {
    name: "the reader's own suggested reply, plain text from the suggested-reply route",
    opensWith: () => {
      // The route answers with JSON; the reader hands `reply` to the composer.
      const response = JSON.parse(
        JSON.stringify({
          suggestion: { status: "suggested", reply: TEXT, citations: [] },
          canSearchWeb: false,
        }),
      );
      return textToHtmlParagraphs(response.suggestion.reply);
    },
  },
  {
    name: "the reader's kept suggestion, read back from this browser's cache",
    opensWith: () => {
      setBrowserCacheUser("user-1", [EMAIL_ACCOUNT_ID]);
      keptSuggestions.set(
        EMAIL_ACCOUNT_ID,
        suggestionKey({ threadId: "thread-1", messageId: "m1", web: false }),
        {
          suggestion: { status: "suggested", reply: TEXT, citations: [] },
          canSearchWeb: false,
        },
      );
      const kept = keptSuggestionFor({
        emailAccountId: EMAIL_ACCOUNT_ID,
        threadId: "thread-1",
        messageId: "m1",
      });
      if (kept?.status !== "suggested") throw new Error("nothing was kept");
      return textToHtmlParagraphs(kept.reply);
    },
  },
  {
    name: "compose assist and the writing partner, through markdownToEmailHtml",
    opensWith: () => markdownToEmailHtml(TEXT, { images: false }),
  },
  {
    name: "a Gmail draft a rule wrote, opened in the composer",
    opensWith: async () => {
      const { html } = await gmailDraftWrittenByRule();
      return prepareEmailDraft({ html }).editableHtml;
    },
  },
  {
    name: "a legacy draft opened before DR-6, repaired",
    opensWith: () => {
      const legacyReply = renderEmailTextWithSafeLinks(TEXT, {
        allowHiddenLinks: false,
      });
      const repaired = withSuggestionEscapesRepaired({
        updatedAt: Date.parse("2026-10-20T09:00:00Z"),
        content: {
          // What the old composer opened with: the stored HTML escaped again.
          draft: { editableHtml: textToHtmlParagraphs(legacyReply) },
          startedFrom: { reply: legacyReply, executedActionId: "action-1" },
        },
      });
      return repaired.content.draft.editableHtml;
    },
  },
];

describe("AI-written text reaches the recipient exactly as written", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it.each(PATHS)("$name", async ({ opensWith }) => {
    const opened = await opensWith();

    // "original" sends the opening as it is; "edited" runs it through the
    // sanitizer too, as a body the user changed does.
    for (const mode of ["original", "edited"] as const) {
      const sent = send(opened, mode);

      expect(visibleText(sent)).toBe(TEXT);
      expect(sent).not.toMatch(/&amp;(#x?[0-9a-f]+|[a-z]+);/i);
      expect(sent).not.toContain("<bracketed");
    }
  });

  it("covers the suggestion text a Gmail draft carries as plain text too", async () => {
    const { text } = await gmailDraftWrittenByRule();

    expect(text.split("\n")[0]).toBe(TEXT);
    expect(text).not.toMatch(/&(#x?[0-9a-f]+|[a-z]+);/i);
  });
});

/** What Send puts in the message when the composer holds `opened`. */
function send(opened: string, mode: "original" | "edited") {
  return combineEmailHtml({
    editableHtml: finalizeEditableEmailHtml({
      html: opened,
      inlineAttachments: [],
      mode,
    }),
  });
}

/** The words a recipient reads in `html`. */
function visibleText(html: string) {
  return (
    new DOMParser().parseFromString(html, "text/html").body.textContent ?? ""
  ).trim();
}

async function storedRuleBody({
  allowHiddenAiDraftLinks,
  signature = null,
}: {
  allowHiddenAiDraftLinks: boolean;
  signature?: string | null;
}) {
  prisma.emailAccount.findUnique.mockResolvedValue({
    allowHiddenAiDraftLinks,
    signature,
  } as never);
  return buildDraftReplyBody({ text: TEXT, emailAccountId: EMAIL_ACCOUNT_ID });
}

async function predraftedBody() {
  prisma.emailAccount.findUnique.mockResolvedValue({
    allowHiddenAiDraftLinks: false,
    signature: null,
  } as never);
  prisma.executedRule.findFirst.mockResolvedValue({ id: "run-1" } as never);
  prisma.executedAction.findFirst.mockResolvedValue(null);
  prisma.executedAction.create.mockResolvedValue({ id: "predraft-1" } as never);
  getSuggestedReplySettings.mockResolvedValue({
    draftReplies: "on",
    webLookupEnabled: false,
  });
  suggestReply.mockResolvedValue({
    status: "suggested",
    reply: TEXT,
    citations: [],
  });
  const toReply: RunRulesResult = {
    rule: { systemType: SystemType.TO_REPLY } as RunRulesResult["rule"],
    status: ExecutedRuleStatus.APPLIED,
    createdAt: new Date(),
  };

  const outcome = await predraftReply({
    emailAccount: { id: EMAIL_ACCOUNT_ID, email: "user@example.com" },
    message: getMockMessage({ id: "message-1", threadId: "thread-1" }),
    results: [toReply],
    provider: {} as EmailProvider,
    logger: createScopedLogger("ai-text-contract"),
  });
  expect(outcome).toBe("drafted");

  const content = prisma.executedAction.create.mock.calls[0][0].data.content;
  if (typeof content !== "string") throw new Error("no pre-draft was stored");
  return content;
}

async function gmailDraftWrittenByRule() {
  const body = await storedRuleBody({ allowHiddenAiDraftLinks: false });
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
