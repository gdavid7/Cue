// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { isUneditedSuggestion } from "@/components/email-list/reply-assist";
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
