import { describe, expect, it, vi } from "vitest";
import {
  getCueStripVisibility,
  getThreadCategories,
  isFromPerson,
} from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import type { EmailLabels } from "@/providers/email-label-types";

vi.mock("@/env", () => ({ env: {} }));

const LABELS: EmailLabels = {
  Label_reply: { id: "Label_reply", name: "To Reply" },
  Label_awaiting: { id: "Label_awaiting", name: "Awaiting Reply" },
  Label_fyi: { id: "Label_fyi", name: "FYI" },
  Label_news: { id: "Label_news", name: "Newsletter" },
  Label_marketing: { id: "Label_marketing", name: "Marketing" },
  Label_receipt: { id: "Label_receipt", name: "Receipt" },
  Label_calendar: { id: "Label_calendar", name: "Calendar" },
  Label_project: { id: "Label_project", name: "Project Alpha" },
};

describe("when the Cue strip shows", () => {
  it.each([
    ["To Reply", "Label_reply"],
    ["Awaiting Reply", "Label_awaiting"],
    ["FYI", "Label_fyi"],
  ])("shows for a conversation labelled %s", (_name, labelId) => {
    expect(visibilityFor({ labels: [labelId] })).toBe("show");
  });

  it.each([
    ["a newsletter", "Label_news"],
    ["marketing", "Label_marketing"],
    ["a receipt", "Label_receipt"],
    ["calendar mail", "Label_calendar"],
  ])("hides for %s, whatever Cue's note says", (_name, labelId) => {
    expect(
      visibilityFor({ labels: [labelId], insight: { action: "reply" } }),
    ).toBe("hide");
  });

  it("goes by the rules Cue ran when it sorts without labelling the mailbox", () => {
    expect(visibilityFor({ planTypes: ["TO_REPLY"] })).toBe("show");
    expect(visibilityFor({ planTypes: ["NEWSLETTER"] })).toBe("hide");
  });

  it("ignores rule runs that were skipped or failed", () => {
    expect(
      getThreadCategories({
        messages: [],
        userLabels: LABELS,
        plans: [
          { status: "SKIPPED", rule: { systemType: "TO_REPLY" } },
          { status: "ERROR", rule: { systemType: "NEWSLETTER" } },
        ],
      }).size,
    ).toBe(0);
  });

  // A mailing someone answered has become a conversation.
  it("lets a conversation category win over a bulk one", () => {
    expect(visibilityFor({ labels: ["Label_news", "Label_reply"] })).toBe(
      "show",
    );
  });

  it("shows for uncategorised mail when Cue's note says it needs the user", () => {
    expect(visibilityFor({ insight: { action: "reply" } })).toBe("show");
    expect(visibilityFor({ insight: { action: "do" } })).toBe("show");
  });

  it("hides for uncategorised mail that asks nothing, or that Cue has no note for", () => {
    expect(visibilityFor({ insight: { action: "none" } })).toBe("hide");
    expect(visibilityFor({ insight: null })).toBe("hide");
  });

  it("ignores labels the user made that share no name with Cue's", () => {
    expect(
      visibilityFor({ labels: ["Label_project"], insight: { action: "none" } }),
    ).toBe("hide");
  });

  // Showing the strip on an insight and then pulling it when the rules say
  // newsletter would flash it; it waits for both.
  it("waits for the thread's rule runs before trusting the note alone", () => {
    expect(
      visibilityFor({ insight: { action: "reply" }, categoriesLoaded: false }),
    ).toBe("pending");
    expect(visibilityFor({ insight: undefined })).toBe("pending");
  });

  // Bulk and machine mail is decided at once, so the reader never holds space
  // for a strip that won't come.
  it("hides for uncategorised mail that isn't from a person, without waiting", () => {
    expect(
      visibilityFor({
        fromPerson: false,
        categoriesLoaded: false,
        insight: undefined,
      }),
    ).toBe("hide");
    expect(
      visibilityFor({ fromPerson: false, insight: { action: "do" } }),
    ).toBe("hide");
  });

  it("still shows for a conversation whose newest message is the user's own", () => {
    expect(
      visibilityFor({ labels: ["Label_awaiting"], fromPerson: false }),
    ).toBe("show");
  });

  it("doesn't wait for anything once a label settles it", () => {
    expect(
      visibilityFor({
        labels: ["Label_reply"],
        categoriesLoaded: false,
        insight: undefined,
      }),
    ).toBe("show");
  });
});

describe("isFromPerson", () => {
  it("counts a person writing from their own address", () => {
    expect(isFromPerson({ from: "Maya Chen <maya@talent.example>" })).toBe(
      true,
    );
  });

  it("doesn't count no-reply and other machine addresses", () => {
    expect(isFromPerson({ from: "Acme <no-reply@acme.example>" })).toBe(false);
    expect(isFromPerson({ from: "notifications@github.com" })).toBe(false);
  });

  it("doesn't count mail sent to a list, which offers an unsubscribe", () => {
    expect(
      isFromPerson({
        from: "Field Notes <hello@fieldnotes.example>",
        "list-unsubscribe": "<https://fieldnotes.example/u>",
      }),
    ).toBe(false);
  });
});

function visibilityFor(options: {
  labels?: string[];
  planTypes?: string[];
  categoriesLoaded?: boolean;
  /** Left out: Cue has no note. Passed as undefined: the note is loading. */
  insight?: { action: "reply" | "do" | "none" } | null;
  fromPerson?: boolean;
}) {
  const {
    labels = [],
    planTypes = [],
    categoriesLoaded = true,
    fromPerson = true,
  } = options;
  const insight = "insight" in options ? options.insight : null;
  return getCueStripVisibility({
    categories: getThreadCategories({
      messages: [{ labelIds: ["INBOX", ...labels] }],
      userLabels: LABELS,
      plans: planTypes.map((systemType) => ({
        status: "APPLIED",
        rule: { systemType },
      })),
    }),
    categoriesLoaded,
    fromPerson,
    insight,
  });
}
