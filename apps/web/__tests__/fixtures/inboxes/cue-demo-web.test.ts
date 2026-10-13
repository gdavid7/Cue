import { describe, expect, it } from "vitest";
import { extractMainLinks } from "@/utils/thread-context/linked-pages";
import { webSearchQuery } from "@/utils/thread-context/suggest-reply";
import { buildCueDemoInbox, cueDemoReplySuggestions } from "./cue-demo-inbox";
import {
  buildCueDemoWebData,
  CUE_DEMO_HANDSHAKE_EVENT_URL,
  cueDemoWebReply,
} from "./cue-demo-web";

const NOW = new Date("2026-10-13T16:00:00Z");

describe("Cue demo web", () => {
  const messages = buildCueDemoInbox(NOW).threads.flatMap((t) => t.messages);
  const web = buildCueDemoWebData(NOW);

  it("serves the page the Handshake email links to", () => {
    const handshake = messages.find((m) =>
      m.bodyText.includes(CUE_DEMO_HANDSHAKE_EVENT_URL),
    );
    expect(handshake).toBeDefined();
    const links = extractMainLinks({
      headers: {
        from: `${handshake?.from.name} <${handshake?.from.email}>`,
        to: "",
        subject: handshake?.subject ?? "",
        date: handshake?.date ?? "",
      },
      textPlain: handshake?.bodyText,
      textHtml: handshake?.bodyHtml,
    });
    expect(links).toEqual([CUE_DEMO_HANDSHAKE_EVENT_URL]);
    expect(web.pages.map((p) => p.url)).toContain(CUE_DEMO_HANDSHAKE_EVENT_URL);
  });

  it("answers Mom's terminal question only after a web search finds the SFO page", () => {
    const plain = cueDemoReplySuggestions.find(
      (s) => s.subject === cueDemoWebReply.subject,
    );
    expect(plain?.object.enoughEvidence).toBe(false);
    expect(messages.map((m) => m.subject)).toContain(cueDemoWebReply.subject);

    const query = webSearchQuery({ webQuery: plain?.object.webQuery ?? "" });
    const found = web.searches.find((s) => s.match.test(query))?.results;
    expect(found?.map((p) => p.url)).toContain(cueDemoWebReply.page.url);
  });

  it("searches the web for nothing when only private mail could settle it", () => {
    const sarah = cueDemoReplySuggestions.find((s) =>
      s.subject.startsWith("Renewal discussion"),
    );
    expect(sarah?.object.enoughEvidence).toBe(false);
    expect(webSearchQuery({ webQuery: sarah?.object.webQuery ?? "" })).toBe("");
  });

  it("quotes only words the demo mail or the cited web page contains", () => {
    const bodies = messages.map((m) => m.bodyText);
    for (const claim of cueDemoWebReply.object("c4").claims) {
      if (claim.sourceId === "c4")
        expect(cueDemoWebReply.page.text).toContain(claim.quote);
      else expect(bodies.some((b) => b.includes(claim.quote))).toBe(true);
    }
  });

  it("dates company news within the last week", () => {
    const news = web.searches
      .filter(
        (s) =>
          s.match.test("acmecorp.com news") || s.match.test("nvidia.com news"),
      )
      .flatMap((s) => s.results);
    expect(news).toHaveLength(4);
    for (const item of news) {
      const age = NOW.getTime() - Date.parse(item.publishedDate ?? "");
      expect(age).toBeGreaterThan(0);
      expect(age).toBeLessThan(7 * 86_400_000);
    }
  });
});
