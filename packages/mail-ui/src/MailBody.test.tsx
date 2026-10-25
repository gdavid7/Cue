import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MailMessageBody } from "./MailBody";

describe("MailMessageBody", () => {
  it("links URLs in a plain-text body", () => {
    const url = `https://click.mail.example.com/ls/click?upn=${"a1-B2_c3".repeat(40)}`;
    const markup = renderToStaticMarkup(
      <MailMessageBody messageId="message-1" text={`Open ${url} today`} />,
    );

    expect(markup).toContain(`href="${url}"`);
    expect(markup).toContain('target="_blank"');
  });
});
