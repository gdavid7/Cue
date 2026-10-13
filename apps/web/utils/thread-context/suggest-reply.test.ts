import { describe, expect, it, vi } from "vitest";
import { checkSuggestion, type Source } from "./suggest-reply";

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
    });
  });

  it("withholds the reply when it cites a source it wasn't given", () => {
    const result = checkSuggestion(
      {
        enoughEvidence: true,
        missing: "",
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
        reply: "",
        claims: [],
      },
      SOURCES,
    );

    expect(result).toEqual({
      status: "insufficient",
      missing: "The agreed renewal price.",
      unsupported: [],
    });
  });
});
