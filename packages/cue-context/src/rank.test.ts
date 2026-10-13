import { describe, expect, it } from "vitest";
import {
  type ContextCandidate,
  type FocusThread,
  focusKeywords,
  orgOf,
  rankContext,
} from "./rank";

const NOW = "2026-10-13T16:00:00Z";
const ME = { email: "david@example.com", name: "David" };
const NORA = { email: "nora@northwind.com", name: "Nora Patel" };
const ARI = { email: "ari@northstar.com", name: "Ari Cohen" };

const focus: FocusThread = {
  id: "t-renewal",
  subject: "Renewal terms still unresolved",
  text: "We need an answer on renewal terms and the multi-year discount before legal review tomorrow.",
  at: "2026-10-12T18:00:00Z",
  people: [NORA, ME],
};

function candidate(
  overrides: Partial<ContextCandidate> & { id: string },
): ContextCandidate {
  return {
    kind: "email",
    title: "Untitled",
    text: "",
    at: "2026-10-10T12:00:00Z",
    people: [],
    ...overrides,
  };
}

const ids = (cands: ContextCandidate[]) =>
  rankContext({
    focus,
    candidates: cands,
    selfEmails: [ME.email],
    now: NOW,
  }).map((r) => r.candidate.id);

describe("rankContext", () => {
  it("prefers items that share a person with the thread, and says who", () => {
    const shared = candidate({
      id: "pricing",
      title: "Pricing sheet v3",
      people: [NORA, ME],
    });
    const unrelated = candidate({
      id: "newsletter",
      title: "Weekly design digest",
      text: "New fonts and colors",
      people: [ME],
    });

    const ranked = rankContext({
      focus,
      candidates: [unrelated, shared],
      selfEmails: [ME.email],
      now: NOW,
    });

    expect(ranked.map((r) => r.candidate.id)).toEqual(["pricing"]);
    expect(ranked[0].reasons).toContainEqual({
      type: "person",
      label: "Nora Patel",
    });
  });

  it("never links items through the user, who is on everything", () => {
    const onlyMe = candidate({
      id: "mine",
      title: "Gym schedule",
      text: "Leg day",
      people: [ME],
    });
    expect(ids([onlyMe])).toEqual([]);
  });

  it("links colleagues at the same company, but not people who share a consumer mail domain", () => {
    const colleague = candidate({
      id: "colleague",
      title: "Procurement checklist",
      people: [{ email: "legal@northwind.com" }],
    });
    expect(ids([colleague])).toEqual(["colleague"]);

    const gmailFocus = {
      ...focus,
      people: [{ email: "friend@gmail.com" }, ME],
    };
    const stranger = candidate({
      id: "stranger",
      title: "Garage sale",
      text: "Bikes",
      people: [{ email: "someone@gmail.com" }],
    });
    expect(
      rankContext({
        focus: gmailFocus,
        candidates: [stranger],
        selfEmails: [ME.email],
        now: NOW,
      }),
    ).toEqual([]);
  });

  it("reaches two hops: someone who was on a related thread", () => {
    const related = candidate({
      id: "cc-thread",
      title: "Re: renewal",
      people: [NORA, ARI, ME],
    });
    const viaAri = candidate({
      id: "ari-meeting",
      kind: "event",
      title: "Deal review",
      at: "2026-10-15T17:00:00Z",
      people: [ARI, ME],
    });

    const ranked = rankContext({
      focus,
      candidates: [related, viaAri],
      selfEmails: [ME.email],
      now: NOW,
    });

    const meeting = ranked.find((r) => r.candidate.id === "ari-meeting");
    expect(meeting?.reasons).toContainEqual({
      type: "via",
      label: "Ari Cohen",
    });
    expect(meeting?.reasons).toContainEqual({ type: "upcoming", days: 2 });
  });

  it("includes an unlinked item only when it's about the same thing", () => {
    const sameTopic = candidate({
      id: "discount-policy",
      title: "Multi-year discount policy",
      text: "Renewal discounts for multi-year terms need legal review.",
      people: [{ email: "finance@ourco.com" }],
    });
    const offTopic = candidate({
      id: "lunch",
      title: "Team lunch Friday",
      text: "Tacos or pizza?",
      people: [{ email: "ops@ourco.com" }],
    });

    const ranked = rankContext({
      focus,
      candidates: [sameTopic, offTopic],
      selfEmails: [ME.email],
      now: NOW,
    });

    expect(ranked.map((r) => r.candidate.id)).toEqual(["discount-policy"]);
    const topic = ranked[0].reasons.find((r) => r.type === "topic");
    expect(topic && "terms" in topic ? topic.terms : []).toEqual(
      expect.arrayContaining(["renewal"]),
    );
  });

  it("surfaces an assignment on the same topic, with when it's due", () => {
    const ranked = rankContext({
      focus,
      candidates: [
        candidate({
          id: "assignment",
          kind: "assignment",
          title: "Renewal terms memo",
          text: "Draft the renewal terms memo for legal review.",
          at: "2026-10-16T06:59:00Z",
          source: "Canvas",
        }),
      ],
      selfEmails: [ME.email],
      now: NOW,
    });

    expect(ranked[0]?.candidate.id).toBe("assignment");
    expect(ranked[0]?.reasons).toContainEqual({ type: "due", days: 2 });
  });

  it("returns at most `limit` items and caps how many of one kind", () => {
    const many = Array.from({ length: 6 }, (_, i) =>
      candidate({ id: `e${i}`, title: `Renewal note ${i}`, people: [NORA] }),
    );
    expect(
      rankContext({
        focus,
        candidates: many,
        selfEmails: [ME.email],
        now: NOW,
        limit: 4,
      }),
    ).toHaveLength(3);
  });

  it("ranks a page the thread links to like a shared person, though no words match", () => {
    const page = candidate({
      id: "web:https://events.example.org/1428571",
      kind: "web",
      title: "Career Series: Tech & Finance",
      text: "Tuesday 6–8pm, Ballroom West",
    });
    const sameOrg = candidate({
      id: "colleague",
      title: "Lunch",
      people: [{ email: "lee@northwind.com" }],
    });

    const ranked = rankContext({
      focus,
      candidates: [sameOrg, page],
      selfEmails: [ME.email],
      now: NOW,
    });

    expect(ranked[0]?.candidate.id).toBe(page.id);
    expect(ranked[0]?.reasons).toEqual([{ type: "linked" }]);
  });

  it("excludes the open thread itself", () => {
    expect(
      ids([candidate({ id: focus.id, title: focus.subject, people: [NORA] })]),
    ).toEqual([]);
  });
});

describe("focusKeywords", () => {
  it("puts subject words first, then frequent body words", () => {
    expect(
      focusKeywords({
        subject: "Q2 rollout copy",
        text: "approval approval launch copy 2026",
      }),
    ).toEqual(["rollout", "copy", "approval", "launch"]);
  });

  it("keeps the body's asks and acronyms when the subject is long", () => {
    expect(
      focusKeywords(
        {
          subject: "Renewal discussion & updated pricing",
          text: "Following up on the SSO security issue. Is SSO fixed?",
        },
        6,
      ),
    ).toEqual([
      "renewal",
      "discussion",
      "updated",
      "pricing",
      "sso",
      "following",
    ]);
  });

  it("skips the names of the people on the thread", () => {
    expect(
      focusKeywords({
        subject: "Milestone 2",
        text: "Hey David, can we meet Wednesday? David, the plots are mine.",
        people: [{ email: "david.lin@ucsd.edu", name: "David Lin" }],
      }),
    ).toEqual(["milestone", "meet", "wednesday", "plots"]);
  });
});

describe("orgOf", () => {
  it("ignores consumer mail domains and automated senders", () => {
    expect(orgOf("a@acme.com")).toBe("acme.com");
    expect(orgOf("a@gmail.com")).toBeNull();
    expect(orgOf("notifications@github.com")).toBeNull();
    expect(orgOf("no-reply+abc@calendar.google.com")).toBeNull();
  });
});

describe("non-English text", () => {
  it("matches on words in any script", () => {
    const hebrewFocus: FocusThread = {
      ...focus,
      subject: "חידוש החוזה",
      text: "צריך תשובה על תנאי החידוש",
      people: [{ email: "dana@company.co.il" }, ME],
    };
    const related = candidate({
      id: "renewal-he",
      title: "תנאי החידוש",
      text: "טיוטה של תנאי החידוש",
      people: [{ email: "legal@other.co.il" }],
    });
    expect(
      rankContext({
        focus: hebrewFocus,
        candidates: [related],
        selfEmails: [ME.email],
        now: NOW,
      }).map((r) => r.candidate.id),
    ).toEqual(["renewal-he"]);
  });
});
