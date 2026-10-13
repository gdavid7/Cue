import { describe, expect, it } from "vitest";
import {
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
