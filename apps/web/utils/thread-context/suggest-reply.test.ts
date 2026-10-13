import { describe, expect, it, vi } from "vitest";
import {
  checkSuggestion,
  renderSource,
  type Source,
  webSearchQuery,
  webSource,
} from "./suggest-reply";

vi.mock("server-only", () => ({}));

const SOURCES: Source[] = [
  {
    id: "m1",
    kind: "message",
    title: "Sarah Chen",
    text: "From: Sarah Chen\n\nCan you confirm the renewal price before Friday?",
  },
  {
    id: "c1",
    kind: "email",
    title: "Acme pricing",
    text: "From: Nora Patel\n\nWe agreed on   $48,000 per year\nfor the Acme renewal & support.",
    threadId: "pricing-thread",
  },
];

describe("checkSuggestion", () => {
  it("suggests the reply when every quote is in the source it cites", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "Hi Sarah, the renewal is $48,000 per year.",
        claims: [
          {
            fact: "The renewal is $48,000 per year",
            sourceId: "c1",
            // Line breaks, spacing, case, curly quotes and an ellipsis differ.
            quote:
              "“…we agreed on $48,000 per year for the Acme renewal &amp; support",
          },
        ],
      },
      SOURCES,
    );

    expect(result).toMatchObject({
      status: "suggested",
      citations: [
        {
          fact: "The renewal is $48,000 per year",
          source: {
            id: "c1",
            title: "Acme pricing",
            threadId: "pricing-thread",
          },
        },
      ],
    });
  });

  it("withholds the reply when a quote isn't in its source", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "Hi Sarah, the renewal is $45,000.",
        claims: [
          {
            fact: "The renewal is $45,000",
            sourceId: "c1",
            quote: "We agreed on $45,000 per year",
          },
        ],
      },
      SOURCES,
    );

    expect(result).toEqual({
      status: "insufficient",
      missing: "",
      unsupported: ["The renewal is $45,000"],
      webQuery: "",
    });
  });

  it("withholds the reply when it cites a source it wasn't given", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
        webQuery: "",
        reply: "See you Thursday.",
        claims: [
          { fact: "The call is Thursday", sourceId: "c9", quote: "Thursday" },
        ],
      },
      SOURCES,
    );

    expect(result.status).toBe("insufficient");
  });

  it("passes on what's missing when the model abstains", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: false,
        missing: "The agreed renewal price.",
        webQuery: "",
        reply: "",
        claims: [],
      },
      SOURCES,
    );

    expect(result).toEqual({
      status: "insufficient",
      missing: "The agreed renewal price.",
      unsupported: [],
      webQuery: "",
    });
  });
});

describe("web sources", () => {
  const page = webSource({
    id: "c3",
    title: "Airlines at SFO",
    url: "https://www.flysfo.com/flights/airlines",
    text: "United Airlines operates from Terminal 3 at SFO.",
  });

  it("render as a web page with its title and domain, like the other kinds", () => {
    expect(renderSource(page)).toBe(
      `<source id="c3" kind="web">
Web page: Airlines at SFO (flysfo.com)
United Airlines operates from Terminal 3 at SFO.
</source>`,
    );
  });

  it("back a reply only with words the page contains", () => {
    const claim = (quote: string) =>
      checkSuggestion(
        {
          enoughEvidence: true,
          missing: "",
          reply: "I land at Terminal 3.",
          claims: [{ fact: "United uses Terminal 3", sourceId: "c3", quote }],
        },
        [...SOURCES, page],
      );

    expect(
      claim("United Airlines operates from Terminal 3 at SFO"),
    ).toMatchObject({
      status: "suggested",
      citations: [
        {
          source: {
            kind: "web",
            url: "https://www.flysfo.com/flights/airlines",
          },
        },
      ],
    });
    expect(claim("United Airlines operates from Terminal 2").status).toBe(
      "insufficient",
    );
  });
});

describe("webSearchQuery", () => {
  // The query leaves Cue for a web search API, so it carries only the public
  // words the model chose: never the subject or what the mail says is missing.
  it("searches for the model's public query and nothing else", () => {
    const abstention = checkSuggestion(
      {
        enoughEvidence: false,
        missing: "Which SFO terminal your United flight lands at.",
        webQuery: "  SFO United   domestic arrivals terminal ",
        reply: "",
        claims: [],
      },
      SOURCES,
    );
    if (abstention.status !== "insufficient")
      throw new Error("expected abstention");
    expect(webSearchQuery(abstention)).toBe(
      "SFO United domestic arrivals terminal",
    );
  });

  it("skips the web when nothing public would settle it", () => {
    expect(webSearchQuery({ webQuery: "  " })).toBe("");
  });
});
