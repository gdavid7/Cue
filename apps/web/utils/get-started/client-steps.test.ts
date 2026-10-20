// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  noteShortcutForGetStarted,
  subscribeGetStartedSteps,
} from "@/utils/get-started/client-steps";

describe("noteShortcutForGetStarted", () => {
  const listener = vi.fn();
  let unsubscribe: () => void;

  beforeEach(() => {
    localStorage.clear();
    listener.mockClear();
    unsubscribe = subscribeGetStartedSteps(listener);
  });
  afterEach(() => unsubscribe());

  it("notes keyboard triage on the fifth triage shortcut, not before", () => {
    for (const id of ["archive", "delete", "snooze", "star"])
      noteShortcutForGetStarted(id);
    expect(listener).not.toHaveBeenCalled();

    noteShortcutForGetStarted("markRead");
    expect(listener).toHaveBeenCalledWith("keyboard");
  });

  it("does not count moving around the list", () => {
    for (let i = 0; i < 10; i++) {
      noteShortcutForGetStarted("next");
      noteShortcutForGetStarted("open");
    }
    expect(listener).not.toHaveBeenCalled();
  });

  it("keeps counting across page loads in this browser", () => {
    localStorage.setItem("cue:get-started:keyboard-triage", "4");
    noteShortcutForGetStarted("archive");
    expect(listener).toHaveBeenCalledWith("keyboard");
  });
});
