// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { sanitizeEmailBodyHtml } from "./email-body";
import { finalizeEditableEmailHtml } from "./email-html";
import { looksLikeMarkdown, markdownToEmailHtml } from "./email-markdown";
import { toEmailStyledHtml } from "./email-styles";

describe("looksLikeMarkdown", () => {
  it.each([
    ["a bulleted list", "Agenda:\n- Budget\n- Hiring"],
    ["a numbered list", "1. Draft\n2. Review"],
    ["a heading", "# Launch plan\nShip it."],
    ["a fenced code block", "Run:\n```\npnpm test\n```"],
    ["a table", "| Name | Role |\n| --- | --- |\n| Ada | Eng |"],
    ["a link", "See [the doc](https://example.com/doc) first."],
  ])("recognizes %s", (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(true);
  });

  it.each([
    ["prose", "Thanks for the update, see you Tuesday."],
    ["a single dash line", "- just one thought"],
    ["emphasis only", "This is *really* important and snake_case_stays."],
    ["an unclosed fence", "```\nhalf a block"],
    ["a hashtag", "#launch day"],
    ["a quoted plain-text reply", "> On Monday you wrote:\n> hello"],
  ])("leaves %s alone", (_name, text) => {
    expect(looksLikeMarkdown(text)).toBe(false);
  });
});

describe("markdownToEmailHtml", () => {
  it("renders block structure as email HTML", () => {
    const html = markdownToEmailHtml(
      [
        "## Plan",
        "",
        "- **Budget** approved",
        "- See [notes](https://example.com/notes)",
        "",
        "| Item | Owner |",
        "| --- | --- |",
        "| Copy | Ada |",
        "",
        "```js",
        "const a = 1 < 2;",
        "```",
      ].join("\n"),
    );
    const doc = parse(html);

    expect(doc.querySelector("h2")?.textContent).toBe("Plan");
    expect(doc.querySelectorAll("ul > li")).toHaveLength(2);
    expect(doc.querySelector("li strong")?.textContent).toBe("Budget");
    expect(doc.querySelector("a")?.getAttribute("href")).toBe(
      "https://example.com/notes",
    );
    expect(doc.querySelector("td")?.textContent).toBe("Copy");
    // The code block keeps its text, without the inner <code> box.
    expect(doc.querySelector("pre")?.textContent).toBe("const a = 1 < 2;\n");
    expect(doc.querySelector("pre code")).toBeNull();
  });

  it("keeps raw HTML in pasted text as text", () => {
    const html = markdownToEmailHtml("- <b>not bold</b>\n- <img src=x>");
    const doc = parse(html);

    expect(doc.querySelector("b, img")).toBeNull();
    expect(doc.body.textContent).toContain("<b>not bold</b>");
  });

  it("shows task list checkboxes as characters mail clients keep", () => {
    const doc = parse(markdownToEmailHtml("- [x] Done\n- [ ] Next"));

    expect(doc.querySelector("input")).toBeNull();
    expect(doc.querySelectorAll("li")[0]?.textContent).toBe("☑ Done");
    expect(doc.querySelectorAll("li")[1]?.textContent).toBe("☐ Next");
  });

  it("keeps single line breaks inside a paragraph", () => {
    const doc = parse(markdownToEmailHtml("Ada\nLondon\n\n- a\n- b"));

    expect(doc.querySelector("p br")).toBeTruthy();
  });
});

describe("toEmailStyledHtml", () => {
  it("styles structure inline and survives sending", () => {
    const styled = toEmailStyledHtml(
      [
        "<h1>Title</h1>",
        "<blockquote><p>Quoted</p></blockquote>",
        "<p>Run <code>pnpm test</code></p>",
        "<pre><code>line 1\nline 2</code></pre>",
        "<table><tr><td>Cell</td></tr></table>",
      ].join(""),
    );
    const sent = parse(
      finalizeEditableEmailHtml({
        html: styled,
        inlineAttachments: [],
        mode: "edited",
      }),
    );

    expect(style(sent, "h1")).toMatch(/font-size:\s*24px/u);
    expect(style(sent, "h1")).toMatch(/margin:/u);
    expect(style(sent, "blockquote")).toMatch(/border-left:/u);
    expect(style(sent, "blockquote")).toMatch(/padding-left:/u);
    expect(style(sent, "code")).toMatch(/font-family:[^;]*monospace/u);
    expect(style(sent, "code")).toMatch(/border:\s*1px solid/u);
    expect(style(sent, "pre")).toMatch(/white-space:\s*pre-wrap/u);
    expect(style(sent, "table")).toMatch(/border-collapse:\s*collapse/u);
    expect(sent.querySelector("table")?.getAttribute("border")).toBe("1");
    expect(sent.querySelector("table")?.getAttribute("cellpadding")).toBe("6");
  });

  it("never fills a background, which dark mode would invert", () => {
    const styled = toEmailStyledHtml(
      "<pre>x</pre><code>y</code><blockquote>z</blockquote><table></table>",
    );

    expect(styled).not.toMatch(/background|(?:^|[^-])color:/u);
  });

  it("keeps styles already on an element and is stable when run twice", () => {
    const once = toEmailStyledHtml(
      '<h2 style="font-size:30px">Big</h2><table border="0"></table>',
    );

    expect(once).toContain("font-size:30px");
    expect(once).not.toMatch(/font-size:20px/u);
    expect(once).toContain('border="0"');
    expect(toEmailStyledHtml(once)).toBe(once);
  });

  it("only adds what the body sanitizer already allows", () => {
    const styled = toEmailStyledHtml(
      "<h3>a</h3><blockquote>b</blockquote><code>c</code><pre>d</pre><table><tr><td>e</td></tr></table>",
    );

    expect(sanitizeEmailBodyHtml(styled)).toBe(styled);
  });
});

function parse(html: string) {
  return new DOMParser().parseFromString(html, "text/html");
}

function style(doc: Document, selector: string) {
  return doc.querySelector(selector)?.getAttribute("style") ?? "";
}
