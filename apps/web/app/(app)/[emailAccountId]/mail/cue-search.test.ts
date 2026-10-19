import { describe, expect, it } from "vitest";
import {
  type CueSearchIntent,
  getCueSearchStage,
  getSearchAnswerRequest,
  getWiderSearches,
  shouldWidenCueSearch,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";

const INTENT: CueSearchIntent = {
  searches: ["from:sarah has:attachment lease OR contract"],
  explanation: "Mail from Sarah with attachments mentioning lease or contract",
  isQuestion: false,
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

describe("shouldWidenCueSearch", () => {
  const wider = getWiderSearches(INTENT.searches);

  it("widens a search that found too little", () => {
    expect(wider).toEqual(["from:sarah lease OR contract"]);
    expect(
      shouldWidenCueSearch({
        stage: stage({ primary: EMPTY }),
        primary: EMPTY,
        widerSearches: wider,
        expired: false,
      }),
    ).toBe(true);
    expect(
      shouldWidenCueSearch({
        stage: stage({ primary: { settled: true, count: 1 } }),
        primary: { settled: true, count: 1 },
        widerSearches: wider,
        expired: false,
      }),
    ).toBe(true);
  });

  it("widens at most once", () => {
    // Once widening, the stage is never "done" with the first searches alone.
    const widening = stage({ primary: EMPTY, widening: true });
    expect(
      shouldWidenCueSearch({
        stage: widening,
        primary: EMPTY,
        widerSearches: wider,
        expired: false,
      }),
    ).toBe(false);
    // A wider search that also finds nothing ends the search.
    const widenedNothing = stage({
      primary: EMPTY,
      widening: true,
      widened: EMPTY,
    });
    expect(widenedNothing).toBe("done");
  });

  it("doesn't widen enough results, unanswered searches, a spent budget, or a search that can't widen", () => {
    const base = {
      stage: stage({ primary: EMPTY }),
      primary: EMPTY,
      widerSearches: wider,
      expired: false,
    };
    expect(
      shouldWidenCueSearch({
        ...base,
        stage: stage({ primary: FOUND }),
        primary: FOUND,
      }),
    ).toBe(false);
    expect(
      shouldWidenCueSearch({ ...base, stage: "searching", primary: IDLE }),
    ).toBe(false);
    expect(shouldWidenCueSearch({ ...base, expired: true })).toBe(false);
    expect(shouldWidenCueSearch({ ...base, widerSearches: [] })).toBe(false);
  });
});

describe("getWiderSearches", () => {
  it("leaves out searches that can't widen and repeats", () => {
    expect(
      getWiderSearches([
        "lease",
        "from:sarah lease",
        "from:sarah after:2026/09/01 lease",
      ]),
    ).toEqual(["from:sarah"]);
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
