import { describe, expect, it } from "vitest";
import {
  type CueSearchIntent,
  fuseSemanticMatches,
  getCueSearchStage,
  getSearchAnswerRequest,
  getWideningLadder,
  getWideningStep,
  keepFrozenRows,
  shouldAskProviderLastResort,
  withoutPlainDuplicates,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";

const INTENT: CueSearchIntent = {
  searches: ["from:sarah has:attachment lease OR contract"],
  editableSearches: ["from:sarah has:attachment lease OR contract"],
  unreadOnly: false,
  explanation: "Mail from Sarah with attachments mentioning lease or contract",
  isQuestion: false,
  timeZone: "UTC",
  parts: {
    senders: ["sarah"],
    recipients: [],
    sentByUser: false,
    keywordGroups: [["lease", "contract"]],
    hasAttachment: true,
    unread: false,
    starred: false,
    label: "",
    dateRange: "none",
    lastNDays: 0,
    fromDate: "",
    toDate: "",
    explanation:
      "Mail from Sarah with attachments mentioning lease or contract",
    isQuestion: false,
  },
};
const IDLE = { settled: false, count: 0 };
const EMPTY = { settled: true, count: 0 };
const FOUND = { settled: true, count: 4 };

function stage(overrides: Partial<Parameters<typeof getCueSearchStage>[0]>) {
  return getCueSearchStage({
    natural: true,
    intent: INTENT,
    expired: false,
    primary: IDLE,
    widening: false,
    widened: IDLE,
    ...overrides,
  });
}

describe("getCueSearchStage", () => {
  it("stays off for a plain search, and when Cue has nothing to run", () => {
    expect(stage({ natural: false })).toBe("off");
    expect(stage({ intent: null })).toBe("off");
    expect(stage({ intent: { ...INTENT, searches: [] } })).toBe("off");
  });

  it("reads, then searches, then is done", () => {
    expect(stage({ intent: undefined })).toBe("reading");
    expect(stage({ primary: IDLE })).toBe("searching");
    expect(stage({ primary: FOUND })).toBe("done");
  });

  it("gives up on a reading that outlasts the budget", () => {
    expect(stage({ intent: undefined, expired: true })).toBe("off");
  });

  it("stops waiting on slow searches once the budget is spent", () => {
    expect(stage({ primary: IDLE, expired: true })).toBe("done");
    expect(stage({ primary: EMPTY, widening: true, expired: true })).toBe(
      "done",
    );
  });

  it("waits for the wider search once it widens", () => {
    expect(stage({ primary: EMPTY, widening: true })).toBe("widening");
    expect(stage({ primary: EMPTY, widening: true, widened: FOUND })).toBe(
      "done",
    );
  });
});

describe("getWideningLadder", () => {
  const context = {
    now: new Date("2026-10-19T17:00:00Z"),
    timeZone: "UTC",
    provider: "google" as const,
  };

  it("climbs from fewer words to sender and dates to a wider window", () => {
    const ladder = getWideningLadder(
      ["from:sarah lease signed after:1788220800"],
      context,
    );
    expect(ladder).toEqual([
      {
        tier: "fewer_words",
        searches: [
          "from:sarah signed after:1788220800",
          "from:sarah lease after:1788220800",
        ],
      },
      { tier: "sender_and_dates", searches: ["from:sarah after:1788220800"] },
      {
        tier: "wider_dates",
        // A window open until now reaches back as far again.
        searches: [
          `from:sarah lease signed after:${2 * 1_788_220_800 - context.now.getTime() / 1000}`,
        ],
      },
    ]);
  });

  it("never runs a search twice, and leaves out tiers with nothing new", () => {
    // Leaving out the one word already leaves the sender and dates.
    const ladder = getWideningLadder(
      ["from:sarah lease after:1788220800", "from:sarah after:1788220800"],
      context,
    );
    expect(ladder.map((step) => step.tier)).toEqual(["wider_dates"]);
    expect(getWideningLadder(["lease"], context)).toEqual([]);
  });
});

describe("getWideningStep", () => {
  const base = {
    step: null,
    primary: EMPTY,
    widened: IDLE,
    ladderLength: 3,
    expired: false,
  };

  it("starts once the searches have answered with too little", () => {
    expect(getWideningStep(base)).toBe(0);
    expect(
      getWideningStep({ ...base, primary: { settled: true, count: 1 } }),
    ).toBe(0);
    expect(getWideningStep({ ...base, primary: FOUND })).toBeNull();
    expect(getWideningStep({ ...base, primary: IDLE })).toBeNull();
    expect(getWideningStep({ ...base, ladderLength: 0 })).toBeNull();
  });

  it("climbs while a tier finds nothing new, and stops at the first that does", () => {
    expect(getWideningStep({ ...base, step: 0, widened: IDLE })).toBe(0);
    expect(getWideningStep({ ...base, step: 0, widened: EMPTY })).toBe(1);
    expect(
      getWideningStep({
        ...base,
        step: 1,
        widened: { settled: true, count: 1 },
      }),
    ).toBe(1);
  });

  it("stops at the top of the ladder and once the budget is spent", () => {
    expect(getWideningStep({ ...base, step: 2, widened: EMPTY })).toBe(2);
    expect(
      getWideningStep({ ...base, step: 0, widened: EMPTY, expired: true }),
    ).toBe(0);
    expect(getWideningStep({ ...base, expired: true })).toBeNull();
  });
});

describe("shouldAskProviderLastResort", () => {
  const top = {
    step: 2,
    primary: EMPTY,
    widened: EMPTY,
    ladderLength: 3,
    expired: false,
  };

  it("asks once every search, the top tier's included, has found no mail", () => {
    expect(shouldAskProviderLastResort(top)).toBe(true);
  });

  it("doesn't ask below the top, while a search is out, after mail is found, or past the budget", () => {
    expect(shouldAskProviderLastResort({ ...top, step: 1 })).toBe(false);
    expect(shouldAskProviderLastResort({ ...top, widened: IDLE })).toBe(false);
    expect(
      shouldAskProviderLastResort({
        ...top,
        primary: { settled: true, count: 1 },
      }),
    ).toBe(false);
    expect(
      shouldAskProviderLastResort({
        ...top,
        widened: { settled: true, count: 1 },
      }),
    ).toBe(false);
    expect(shouldAskProviderLastResort({ ...top, expired: true })).toBe(false);
  });
});

describe("getSearchAnswerRequest", () => {
  const query = "when is my flight?";

  it("answers a plain search from its words, as before", () => {
    expect(
      getSearchAnswerRequest({
        query: "flight",
        natural: false,
        intent: undefined,
        stage: "off",
      }),
    ).toEqual({ query: "flight" });
  });

  it("waits for Cue's reading of a sentence before asking", () => {
    expect(
      getSearchAnswerRequest({
        query,
        natural: true,
        intent: undefined,
        stage: "reading",
      }),
    ).toBeNull();
  });

  it("answers a question from the searches Cue made", () => {
    expect(
      getSearchAnswerRequest({
        query,
        natural: true,
        intent: {
          ...INTENT,
          searches: ["flight OR boarding"],
          isQuestion: true,
        },
        stage: "searching",
      }),
    ).toEqual({ query, searches: ["flight OR boarding"] });
  });

  it("asks nothing for a sentence that only looks for mail", () => {
    expect(
      getSearchAnswerRequest({
        query: "the lease Sarah sent",
        natural: true,
        intent: INTENT,
        stage: "done",
      }),
    ).toBeNull();
  });

  it("falls back to the typed words when Cue couldn't read the search", () => {
    expect(
      getSearchAnswerRequest({
        query,
        natural: true,
        intent: null,
        stage: "off",
      }),
    ).toEqual({ query });
    expect(
      getSearchAnswerRequest({
        query,
        natural: true,
        intent: undefined,
        stage: "off",
      }),
    ).toEqual({ query });
  });
});

describe("keepFrozenRows", () => {
  it("keeps out mail found after the budget, in its latest state", () => {
    const live = [row("late"), { ...row("a"), snippet: "now read" }, row("b")];
    expect(keepFrozenRows(live, ["a", "b"])).toEqual([live[1], live[2]]);
    expect(keepFrozenRows(live, null)).toBe(live);
  });
});

describe("withoutPlainDuplicates", () => {
  it("hides rows anywhere in the loaded plain results, and only those", () => {
    const plain = Array.from({ length: 8 }, (_, i) => row(`p${i}`));
    const cue = [row("p0"), row("new"), row("p6")];
    expect(withoutPlainDuplicates(cue, plain).map((t) => t.id)).toEqual([
      "new",
    ]);
    // The plain list is left as it is.
    expect(plain.map((t) => t.id)[0]).toBe("p0");
  });
});

function row(id: string) {
  return { id, messages: [{ id: `${id}-m` }], snippet: "" };
}

describe("fuseSemanticMatches", () => {
  it("keeps each conversation once, at the closest any search by meaning found it, closest first", () => {
    const typed = [
      { messageId: "m-invoice", conversationId: "invoice", similarity: 0.37 },
      { messageId: "m-flight", conversationId: "flight", similarity: 0.28 },
    ];
    const reading = [
      { messageId: "m-flight-2", conversationId: "flight", similarity: 0.54 },
      { messageId: "m-hotel", conversationId: "hotel", similarity: 0.51 },
    ];
    expect(fuseSemanticMatches([typed, reading], 10)).toEqual([
      { messageId: "m-flight-2", conversationId: "flight", similarity: 0.54 },
      { messageId: "m-hotel", conversationId: "hotel", similarity: 0.51 },
      { messageId: "m-invoice", conversationId: "invoice", similarity: 0.37 },
    ]);
  });

  it("keeps the limit across the searches", () => {
    const matches = (prefix: string, count: number) =>
      Array.from({ length: count }, (_, index) => ({
        messageId: `${prefix}-${index}`,
        conversationId: `${prefix}-${index}`,
        similarity: 0.9 - index / 100,
      }));
    expect(
      fuseSemanticMatches([matches("a", 10), matches("b", 10)], 15),
    ).toHaveLength(15);
  });
});
