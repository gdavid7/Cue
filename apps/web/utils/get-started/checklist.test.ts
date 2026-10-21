import { describe, expect, it } from "vitest";
import {
  GET_STARTED_DISMISSED_HINT,
  getFirstReplySentHintId,
  getGetStartedItems,
  getGetStartedStatus,
  getGetStartedStepHintId,
  isGetStartedWindowOpen,
  type GetStartedFacts,
} from "@/utils/get-started/checklist";
import { getInboxStyleHintId } from "@/utils/split-inbox/inbox-styles";

const NOW = new Date("2026-10-20T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;
const NO_FACTS: GetStartedFacts = {
  calendarAccountIds: new Set(),
  chatAccountIds: new Set(),
  sentSuggestionAccountIds: new Set(),
};

function doneIds(dismissedHints: string[], facts = NO_FACTS) {
  return getGetStartedItems({
    dismissedHints,
    emailAccountIds: ["a", "b"],
    facts,
  })
    .filter((item) => item.done)
    .map((item) => item.id);
}

describe("getGetStartedItems", () => {
  it("starts with nothing done", () => {
    expect(doneIds([])).toEqual([]);
  });

  it("counts a step done in any of the person's accounts", () => {
    expect(
      doneIds([getInboxStyleHintId("b"), getFirstReplySentHintId("a")], {
        ...NO_FACTS,
        calendarAccountIds: new Set(["b"]),
      }),
    ).toEqual(["inbox-style", "reply", "calendar"]);
  });

  it("ignores steps done in someone else's account", () => {
    expect(
      doneIds([getInboxStyleHintId("other")], {
        calendarAccountIds: new Set(["other"]),
        chatAccountIds: new Set(["other"]),
        sentSuggestionAccountIds: new Set(["other"]),
      }),
    ).toEqual([]);
  });

  it("completes reply from a sent suggestion the database recorded", () => {
    expect(
      doneIds([], { ...NO_FACTS, sentSuggestionAccountIds: new Set(["a"]) }),
    ).toEqual(["reply"]);
  });

  it("completes ask from a chat or from a search the browser saved", () => {
    expect(
      doneIds([], { ...NO_FACTS, chatAccountIds: new Set(["a"]) }),
    ).toEqual(["ask"]);
    expect(doneIds([getGetStartedStepHintId("ask")])).toEqual(["ask"]);
  });

  it("completes browser-only steps from their saved hints", () => {
    expect(
      doneIds([
        getGetStartedStepHintId("keyboard"),
        getGetStartedStepHintId("phone"),
      ]),
    ).toEqual(["keyboard", "phone"]);
  });
});

describe("getGetStartedStatus", () => {
  const items = (doneCount: number) =>
    Array.from({ length: 6 }, (_, index) => ({ done: index < doneCount }));
  const user = (ageDays: number, dismissedHints: string[] = []) => ({
    createdAt: new Date(NOW.getTime() - ageDays * DAY),
    dismissedHints,
  });

  it("shows during the first week while steps remain", () => {
    expect(
      getGetStartedStatus({ user: user(6.9), items: items(5), now: NOW }),
    ).toBe("active");
  });

  it("hides once every step is done", () => {
    expect(
      getGetStartedStatus({ user: user(1), items: items(6), now: NOW }),
    ).toBe("done");
  });

  it("hides after seven days", () => {
    expect(
      getGetStartedStatus({ user: user(7), items: items(2), now: NOW }),
    ).toBe("expired");
    expect(isGetStartedWindowOpen(user(7), NOW)).toBe(false);
  });

  it("hides for good once closed", () => {
    const closed = user(1, [GET_STARTED_DISMISSED_HINT]);
    expect(
      getGetStartedStatus({ user: closed, items: items(2), now: NOW }),
    ).toBe("dismissed");
    expect(isGetStartedWindowOpen(closed, NOW)).toBe(false);
  });

  it("accepts the creation date as the API serializes it", () => {
    expect(
      isGetStartedWindowOpen(
        {
          createdAt: new Date(NOW.getTime() - DAY).toISOString(),
          dismissedHints: [],
        },
        NOW,
      ),
    ).toBe(true);
  });
});
