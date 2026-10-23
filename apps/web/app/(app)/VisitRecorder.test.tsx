// @vitest-environment jsdom

import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RECORD_VISIT_EVERY_MS,
  resetRecordVisitForTesting,
} from "@/utils/user/record-visit";
import { VisitRecorder } from "./VisitRecorder";

const mocks = vi.hoisted(() => ({ recordVisitAction: vi.fn() }));
vi.mock("@/utils/actions/away-summary", () => ({
  recordVisitAction: mocks.recordVisitAction,
}));

let visibility: DocumentVisibilityState = "visible";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-23T09:00:00Z"));
  localStorage.clear();
  resetRecordVisitForTesting();
  mocks.recordVisitAction.mockReset().mockResolvedValue({});
  visibility = "visible";
  vi.spyOn(document, "visibilityState", "get").mockImplementation(
    () => visibility,
  );
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("VisitRecorder", () => {
  it("records on load, then while the user works in the app, every ten minutes at most", async () => {
    render(<VisitRecorder />);
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);
    await act(() => Promise.resolve());

    // Clicking around Mail a minute later changes nothing yet.
    vi.setSystemTime(Date.now() + 60_000);
    fireEvent.pointerDown(window);
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);

    // Still working after ten minutes: recorded again, so hours in Mail
    // never look like a break when Today opens.
    vi.setSystemTime(Date.now() + RECORD_VISIT_EVERY_MS);
    fireEvent.keyDown(window, { key: "j" });
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(2);
  });

  it("records when the tab comes back into view, not while it's hidden", async () => {
    render(<VisitRecorder />);
    await act(() => Promise.resolve());
    vi.setSystemTime(Date.now() + 5 * 60 * 60_000);

    visibility = "hidden";
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(1);

    visibility = "visible";
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.recordVisitAction).toHaveBeenCalledTimes(2);
  });

  it("shares the ten minutes with this browser's other tabs", () => {
    localStorage.setItem("cue:visit-recorded-at", String(Date.now() - 60_000));
    render(<VisitRecorder />);
    expect(mocks.recordVisitAction).not.toHaveBeenCalled();
  });
});
