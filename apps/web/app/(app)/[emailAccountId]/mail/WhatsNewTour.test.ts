// @vitest-environment jsdom

import { afterEach, describe, expect, it } from "vitest";
import {
  findNeedsReplyTab,
  getNeedsReplyStepCopy,
  getTourStepView,
  INSIGHT_WAIT_MS,
} from "@/app/(app)/[emailAccountId]/mail/WhatsNewTour";

describe("getTourStepView", () => {
  it("shows a step as soon as its target is on screen", () => {
    expect(
      getTourStepView({
        hasTarget: true,
        waitedMs: 0,
        waitForTargetMs: INSIGHT_WAIT_MS,
      }),
    ).toBe("show");
  });

  it("keeps waiting for insights that haven't been written yet", () => {
    expect(
      getTourStepView({
        hasTarget: false,
        waitedMs: INSIGHT_WAIT_MS - 1,
        waitForTargetMs: INSIGHT_WAIT_MS,
      }),
    ).toBe("wait");
  });

  it("skips the step once the wait runs out, rather than pointing at nothing", () => {
    expect(
      getTourStepView({
        hasTarget: false,
        waitedMs: INSIGHT_WAIT_MS,
        waitForTargetMs: INSIGHT_WAIT_MS,
      }),
    ).toBe("skip");
  });

  it("skips a step that doesn't wait when its target is missing", () => {
    expect(
      getTourStepView({ hasTarget: false, waitedMs: 0, waitForTargetMs: 0 }),
    ).toBe("skip");
  });
});

describe("the Needs reply step", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("names how many emails need a reply", () => {
    expect(getNeedsReplyStepCopy(4)).toEqual({
      title: "Cue found 4 emails that need your reply.",
      body: "Start there; the ones marked Draft ready already have a reply waiting.",
      showTab: true,
    });
    expect(getNeedsReplyStepCopy(1).title).toBe(
      "Cue found 1 email that needs your reply.",
    );
  });

  // An empty tab can mean sorting is still running or the AI is off, so the
  // step must not claim that nothing needs a reply.
  it("points at the tab without claiming nothing needs a reply", () => {
    expect(getNeedsReplyStepCopy(0)).toEqual({
      title: "Needs reply fills in as Cue reads your mail.",
      body: "Mail waiting on your answer lands here, with a draft when Cue can write one.",
      showTab: false,
    });
  });

  it("has no target, so is skipped, without Cue's tabs", () => {
    document.body.innerHTML = `<button data-split-tab aria-label="All">All</button>`;
    expect(findNeedsReplyTab({ withReplies: false })).toBeNull();
  });

  it("waits for a count before claiming anything needs a reply", () => {
    document.body.innerHTML = `<button data-split-tab aria-label="Needs reply" data-split-matching="0">Needs reply</button>`;
    expect(findNeedsReplyTab({ withReplies: true })).toBeNull();
    expect(findNeedsReplyTab({ withReplies: false })).not.toBeNull();

    document.querySelector("button")?.setAttribute("data-split-matching", "3");
    expect(findNeedsReplyTab({ withReplies: true })).not.toBeNull();
  });
});
