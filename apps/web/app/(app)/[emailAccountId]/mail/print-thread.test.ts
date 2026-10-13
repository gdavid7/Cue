import { describe, expect, it } from "vitest";
import { buildPrintableThreadHtml } from "./print-thread";

describe("buildPrintableThreadHtml", () => {
  it("prints every message with its headers, escaping what the sender wrote", () => {
    const html = buildPrintableThreadHtml({
      subject: "Plans <for> Friday",
      messages: [
        {
          from: "Dana <dana@example.com>",
          to: "me@example.com",
          date: "2026-01-02T10:00:00.000Z",
          bodyHtml: "<p>First</p>",
        },
        {
          from: "me@example.com",
          cc: "alex@example.com",
          date: "not a date",
          bodyHtml: "<p>Second</p>",
        },
      ],
    });

    expect(html).toContain("<title>Plans &lt;for&gt; Friday</title>");
    expect(html).toContain("Dana &lt;dana@example.com&gt;");
    expect(html).toContain("<dt>Cc</dt><dd>alex@example.com</dd>");
    expect(html).toContain("not a date");
    expect(html.indexOf("<p>First</p>")).toBeLessThan(
      html.indexOf("<p>Second</p>"),
    );
    expect(html).toContain("Content-Security-Policy");
  });
});
