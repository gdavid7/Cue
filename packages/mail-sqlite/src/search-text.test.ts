import { describe, expect, it } from "vitest";
import {
  htmlToSearchText,
  searchableAttachments,
  searchableText,
  searchMatchQuery,
} from "./search-text";

describe("htmlToSearchText", () => {
  it("keeps visible text and drops markup, styles, scripts, head, and comments", () => {
    const html = `<!DOCTYPE html><html><head><title>Hidden title</title>
      <style type="text/css">.font-large { font-family: Arial }</style></head>
      <body><!--[if mso]><table><tr><td><![endif]-->
      <table style="font-size:14px"><tr><td class="column">Quarterly <b>report</b></td>
      <td><a href="https://click.example.com/track?utm_source=news">Read more</a></td></tr></table>
      <script>var tracking = "pixel";</script>
      <img src="https://img.example.com/pixel.gif" alt=""></body></html>`;

    expect(htmlToSearchText(html)).toBe("Quarterly report Read more");
  });

  it("joins inline tags inside a word and separates block tags", () => {
    expect(htmlToSearchText("<p>in<b>voice</b></p><p>total</p>")).toBe(
      "invoice total",
    );
    expect(htmlToSearchText("line one<br>line two<div>three</div>")).toBe(
      "line one line two three",
    );
  });

  it("decodes named, accented, and numeric entities", () => {
    expect(
      htmlToSearchText(
        "Caf&eacute; &amp; cr&egrave;me&nbsp;br&ucirc;l&eacute;e &#8212; &#x41;BC &lt;tag&gt; &unknown; &copy",
      ),
    ).toBe("Café & crème brûlée — ABC <tag> &unknown; ©");
  });

  it("ignores angle brackets inside quoted attributes", () => {
    expect(htmlToSearchText('<a title="a > b">Link</a> text')).toBe(
      "Link text",
    );
  });

  it("leaves a stray less-than sign as text", () => {
    expect(htmlToSearchText("<p>1 < 2 and 3 > 2</p>")).toBe("1 < 2 and 3 > 2");
  });
});

describe("searchMatchQuery", () => {
  it("ANDs each term as a quoted prefix token", () => {
    expect(searchMatchQuery("quarterly invoice inv", "term")).toBe(
      '"quarterly"* "invoice"* "inv"*',
    );
  });

  it("also matches two words or a hyphenated term written as one word", () => {
    expect(searchMatchQuery("wi fi", "term")).toBe('("wi"* "fi"*) OR "wifi"*');
    expect(searchMatchQuery("wi-fi setup guide", "term")).toBe(
      '("wi-fi"* OR "wifi"*) "setup"* "guide"*',
    );
    expect(searchMatchQuery("wi-fi", "phrase")).toBe('"wi-fi"*');
  });

  it("keeps a phrase together with a prefix on its last word", () => {
    expect(searchMatchQuery("quarterly inv", "phrase")).toBe(
      '"quarterly inv"*',
    );
  });

  it("neutralizes quotes, operators, and column filters", () => {
    expect(searchMatchQuery('subject:"x" OR NEAR(a) -b ^c', "term")).toBe(
      '"subject:""x"""* "OR"* "NEAR(a)"* "-b"* "^c"*',
    );
  });

  it("matches a single character as a whole word", () => {
    expect(searchMatchQuery("a invoice due", "term")).toBe(
      '"a" "invoice"* "due"*',
    );
  });

  it("splits scripts written without spaces into a character phrase", () => {
    expect(searchMatchQuery("請求書 invoice", "term")).toBe(
      '"請 求 書"* "invoice"*',
    );
  });

  it("drops terms with nothing to search for", () => {
    expect(searchMatchQuery("invoice ---", "term")).toBe('"invoice"*');
    expect(searchMatchQuery("... invoice ---", "term")).toBe('"invoice"*');
    expect(searchMatchQuery("... ---", "term")).toBeNull();
    expect(searchMatchQuery('"*"', "phrase")).toBeNull();
  });
});

describe("searchableText", () => {
  it("adds hyphenated compounds joined, after the text", () => {
    expect(searchableText("Wi-Fi and e‑mail, not -x")).toBe(
      "Wi-Fi and e‑mail, not -x WiFi email",
    );
    expect(searchableText("請求書")).toBe(" 請  求  書 ");
  });
});

describe("searchableAttachments", () => {
  it("indexes real attachments by name and short format", () => {
    expect(
      searchableAttachments([
        {
          filename: "Q3-report.xlsx",
          mimeType: "application/vnd.ms-excel",
          inline: false,
        },
        { filename: "scan", mimeType: "image/JPEG", inline: false },
        { filename: "logo.png", mimeType: "image/png", inline: true },
      ]),
    ).toBe("Q3-report.xlsx Q3report scan jpeg");
  });
});
