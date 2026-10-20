// @vitest-environment jsdom

import {
  combineEmailHtml,
  finalizeEditableEmailHtml,
  prepareEmailDraft,
} from "@inboxzero/email-editor/core";
import { describe, expect, it } from "vitest";
import {
  draftHtmlToReplyText,
  isUneditedSuggestion,
  isUnwrittenReply,
  withSuggestionEscapesRepaired,
} from "@/components/email-list/reply-assist";
import { renderEmailTextWithSafeLinks } from "@/utils/email/render-safe-links";
import { textToHtmlParagraphs } from "@/utils/string";

const REPLY =
  "Hi Kevin,\n\nOffice hours are Thursday at 4pm in CSE 1202.\nSee you then!";

describe("isUneditedSuggestion", () => {
  it("recognizes the suggestion as the composer wrote it", () => {
    expect(isUneditedSuggestion(textToHtmlParagraphs(REPLY), REPLY)).toBe(true);
  });

  it("recognizes it as the mailbox saved it, with markup and a signature", () => {
    const saved = `<div dir="ltr"><div>Hi Kevin,</div><div><br></div><div>Office hours are Thursday at&nbsp;4pm in CSE 1202.<br>See you then!</div><div data-smartmail="gmail_signature">David</div></div>`;

    expect(isUneditedSuggestion(saved, REPLY)).toBe(true);
  });

  it("treats any change to the words as the user's own", () => {
    const edited = textToHtmlParagraphs(REPLY.replace("4pm", "5pm"));

    expect(isUneditedSuggestion(edited, REPLY)).toBe(false);
    expect(
      isUneditedSuggestion(
        `${textToHtmlParagraphs(REPLY)}<p>Thanks</p>`,
        REPLY,
      ),
    ).toBe(false);
  });

  it("does not credit an empty reply", () => {
    expect(isUneditedSuggestion("", "")).toBe(false);
  });
});

// Once one reply to a message is sent, the other is dropped only when the
// user wrote nothing in it.
describe("isUnwrittenReply", () => {
  const values = {
    to: "finance@example.com",
    cc: "",
    bcc: "",
    subject: "Re: Invoice",
  };
  const reply = (
    editableHtml: string,
    extra: Record<string, unknown> = {},
  ) => ({
    draft: { editableHtml },
    values,
    attachments: [],
    ...extra,
  });

  it("treats an empty reply as unwritten", () => {
    expect(isUnwrittenReply(reply("<p><br></p>"))).toBe(true);
  });

  it("treats Cue's reply, untouched, as unwritten", () => {
    expect(
      isUnwrittenReply(
        reply(textToHtmlParagraphs(REPLY), {
          startedFrom: { reply: REPLY, values },
        }),
      ),
    ).toBe(true);
  });

  it("keeps a reply with any typed words, files or changed recipients", () => {
    expect(isUnwrittenReply(reply("<p>Paid last week.</p>"))).toBe(false);
    expect(
      isUnwrittenReply(
        reply(textToHtmlParagraphs(`${REPLY} Thanks`), {
          startedFrom: { reply: REPLY, values },
        }),
      ),
    ).toBe(false);
    expect(
      isUnwrittenReply(reply("<p></p>", { attachments: [{ id: "file-1" }] })),
    ).toBe(false);
    expect(
      isUnwrittenReply({
        ...reply(textToHtmlParagraphs(REPLY), {
          startedFrom: { reply: REPLY, values },
        }),
        values: { ...values, cc: "boss@example.com" },
      }),
    ).toBe(false);
  });
});

describe("draftHtmlToReplyText", () => {
  const TEXT = `I'm going to look at "Q3" & check <the> numbers.\n\nI'll reply by 5.`;

  // What Send puts in the message when the user sends Cue's reply untouched:
  // the composer's opening HTML, sent exactly as loaded.
  function sentHtml(storedContent: string) {
    return sentReply(draftHtmlToReplyText(storedContent));
  }

  function sentReply(reply: string) {
    const draft = prepareEmailDraft({ html: textToHtmlParagraphs(reply) });
    return combineEmailHtml({
      editableHtml: finalizeEditableEmailHtml({
        html: draft.editableHtml,
        inlineAttachments: [],
        mode: draft.mode,
      }),
    });
  }

  function recipientSees(html: string) {
    return new DOMParser().parseFromString(html, "text/html").body;
  }

  it("sends the rule's reply with its punctuation as written, escaped once", () => {
    const html = sentHtml(
      renderEmailTextWithSafeLinks(TEXT, { allowHiddenLinks: false }),
    );
    const body = recipientSees(html);

    expect(body.querySelectorAll("p")).toHaveLength(2);
    expect(body.querySelectorAll("p")[0].textContent).toBe(
      `I'm going to look at "Q3" & check <the> numbers.`,
    );
    expect(body.querySelectorAll("p")[1].textContent).toBe("I'll reply by 5.");
    expect(html).not.toMatch(/&amp;(#x?[0-9a-f]+|[a-z]+);/i);
  });

  // A reply Cue worked out in the reader, or kept in this browser, is plain
  // text already and goes straight to the composer.
  it("sends a reader suggestion's punctuation as written, escaped once", () => {
    const html = sentReply(TEXT);

    expect(recipientSees(html).textContent).toBe(TEXT.replace("\n\n", ""));
    expect(html).not.toMatch(/&amp;(#x?[0-9a-f]+|[a-z]+);/i);
  });

  it("never turns the model's text into markup", () => {
    const body = recipientSees(
      sentHtml(
        renderEmailTextWithSafeLinks(
          `Sure <img src=x onerror="alert(1)"><script>alert(2)</script>`,
          { allowHiddenLinks: false },
        ),
      ),
    );

    expect(body.querySelector("img, script")).toBeNull();
    expect(body.textContent).toBe(
      `Sure <img src=x onerror="alert(1)"><script>alert(2)</script>`,
    );
  });

  it("keeps a link's destination when the reply hid it behind words", () => {
    const stored = renderEmailTextWithSafeLinks(
      "See [the doc](https://example.com/doc?a=1&b=2) & reply.",
      { allowHiddenLinks: true },
    );

    expect(draftHtmlToReplyText(stored)).toBe(
      "See the doc (https://example.com/doc?a=1&b=2) & reply.",
    );
  });

  // The reader gets the body without its signature (DR-6b); a template's own
  // markup still splits into lines.
  it("keeps line breaks and block lines", () => {
    expect(
      draftHtmlToReplyText(
        "Thanks &amp; talk soon\n\n<div>Agenda</div><div>R&amp;D, then Q&amp;A</div>",
      ),
    ).toBe("Thanks & talk soon\n\nAgenda\nR&D, then Q&A");
  });

  it("shows none of a template's styles, scripts or comments", () => {
    expect(
      draftHtmlToReplyText(
        "<head><title>T</title></head><style>p > a { color: red }</style><!-- a > b -->Hi<script>if (a > b) x()</script> there",
      ),
    ).toBe("Hi there");
  });

  it("shows nothing of conditional comments, a doctype or an unclosed style", () => {
    expect(
      draftHtmlToReplyText(
        "<!DOCTYPE html><![if !mso]><div>Hi</div><![endif]> there<style>p { color: red }",
      ),
    ).toBe("Hi\nthere");
  });

  it("keeps a preformatted block's spacing and lists' lines", () => {
    expect(
      draftHtmlToReplyText(
        "Steps:<ul><li>One</li><li>Two</li></ul><pre>a  b\n  c</pre>Done   now",
      ),
    ).toBe("Steps:\nOne\nTwo\na  b\n  c\nDone now");
  });

  it("reads a table's cells apart and a quoted > as part of its tag", () => {
    expect(
      draftHtmlToReplyText(
        `<table><tr><td>Mon</td><td title="a > b">10am</td></tr><tr><th>Tue</th><td>2pm</td></tr></table>`,
      ),
    ).toBe("Mon 10am\nTue 2pm");
  });
});

describe("withSuggestionEscapesRepaired", () => {
  // Opened before DR-6: the stored HTML went through the composer's escape
  // as if it were text.
  const OLD_REPLY = renderEmailTextWithSafeLinks(`I'm sure "Q3" & <Q4> work.`, {
    allowHiddenLinks: false,
  });
  function stored(editableHtml: string, executedActionId = "action-1") {
    return {
      revision: 1,
      content: {
        draft: { editableHtml, mode: "original" as const },
        startedFrom: { reply: OLD_REPLY, executedActionId },
      },
    };
  }

  it("brings back the punctuation of a draft Cue's reply opened, untouched", () => {
    const repaired = withSuggestionEscapesRepaired(
      stored(textToHtmlParagraphs(OLD_REPLY)),
    );
    const html = repaired.content.draft.editableHtml;

    expect(
      new DOMParser().parseFromString(html, "text/html").body.textContent,
    ).toBe(`I'm sure "Q3" & <Q4> work.`);
    expect(repaired.content.startedFrom.reply).toBe(
      `I'm sure "Q3" & <Q4> work.`,
    );
    expect(isUneditedSuggestion(html, repaired.content.startedFrom.reply)).toBe(
      true,
    );
  });

  it("repairs it after the user edited around it too", () => {
    const repaired = withSuggestionEscapesRepaired(
      stored(`${textToHtmlParagraphs(OLD_REPLY)}<p>Thanks &amp; bye</p>`),
    );

    expect(
      new DOMParser().parseFromString(
        repaired.content.draft.editableHtml,
        "text/html",
      ).body.textContent,
    ).toBe(`I'm sure "Q3" & <Q4> work.Thanks & bye`);
  });

  it("opens an untouched one from the decoded reply, markup and all", () => {
    const reply = `Sure &amp; see <a href="https://example.com/doc">the doc</a>.\n\n<div>Sam</div>`;
    const repaired = withSuggestionEscapesRepaired({
      content: {
        draft: { editableHtml: textToHtmlParagraphs(reply) },
        startedFrom: { reply, executedActionId: "action-1" },
      },
    });
    const html = repaired.content.draft.editableHtml;

    expect(
      new DOMParser().parseFromString(html, "text/html").body.textContent,
    ).toBe("Sure & see the doc (https://example.com/doc).Sam");
    expect(html).not.toContain("&lt;");
    expect(isUneditedSuggestion(html, repaired.content.startedFrom.reply)).toBe(
      true,
    );
  });

  it("opens one whose stored reply had only markup without its tags", () => {
    const reply = `Yes.\n\n<div dir="ltr">Sam<br>Acme</div>`;
    const repaired = withSuggestionEscapesRepaired({
      content: {
        draft: { editableHtml: textToHtmlParagraphs(reply) },
        startedFrom: { reply, executedActionId: "action-1" },
      },
    });

    expect(repaired.content.draft.editableHtml).toBe(
      "<p>Yes.</p><p>Sam<br />Acme</p>",
    );
    expect(repaired.content.startedFrom).toMatchObject({
      reply: "Yes.\n\nSam\nAcme",
      decoded: true,
    });
  });

  it("only undoes the second escape once the opening was edited", () => {
    const repaired = withSuggestionEscapesRepaired(
      stored(`<p>Hi,</p>${textToHtmlParagraphs(OLD_REPLY)}`),
    );

    expect(
      new DOMParser().parseFromString(
        repaired.content.draft.editableHtml,
        "text/html",
      ).body.textContent,
    ).toBe(`Hi,I'm sure "Q3" & <Q4> work.`);
  });

  // The model wrote "&amp;" itself, so the stored reply escaped it twice.
  it("repairs a reply escaped twice over only once", () => {
    const reply = renderEmailTextWithSafeLinks("Type &amp; for &.", {
      allowHiddenLinks: false,
    });
    const once = withSuggestionEscapesRepaired({
      content: {
        draft: { editableHtml: textToHtmlParagraphs(reply) },
        startedFrom: { reply, executedActionId: "action-1" },
      },
    });

    expect(once.content.startedFrom.reply).toBe("Type &amp; for &.");
    expect(withSuggestionEscapesRepaired(once)).toBe(once);
  });

  it("repairs a draft once", () => {
    const once = withSuggestionEscapesRepaired(
      stored(textToHtmlParagraphs(OLD_REPLY)),
    );

    expect(withSuggestionEscapesRepaired(once)).toBe(once);
  });

  // Opened since DR-6: the reply is plain text, escaped once by the composer.
  it("leaves a draft written since, or the user's own, as it is", () => {
    const opened = (
      reply: string,
      editableHtml = textToHtmlParagraphs(reply),
    ) => ({
      revision: 1,
      content: {
        draft: { editableHtml },
        startedFrom: { reply, executedActionId: "action-1", decoded: true },
      },
    });
    const current = opened("I'm & you");
    const withTags = opened("Use <b> please");
    const literalEntity = opened("Write R&amp;D, not R&D.");
    const typedBreak = opened(
      "Yes.",
      "<p>Yes.</p><p>Use &lt;br&gt;<br>here</p>",
    );
    const typedEntity = opened(
      "Yes.",
      `${textToHtmlParagraphs("Yes.")}<p>Type &amp;amp; for &amp;</p>`,
    );
    const own = {
      revision: 1,
      content: { draft: { editableHtml: "<p>&amp;amp; is how</p>" } },
    };

    for (const draft of [
      current,
      withTags,
      literalEntity,
      typedBreak,
      typedEntity,
      own,
    ]) {
      expect(withSuggestionEscapesRepaired(draft)).toBe(draft);
    }
  });
});
