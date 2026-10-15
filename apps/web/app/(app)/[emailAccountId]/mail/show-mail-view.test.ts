/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from "vitest";
import { showMailView } from "./show-mail-view";

describe("showMailView", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/mail/u/1/inbox");
  });

  it("shows another view of the open mail screen as a new history entry", () => {
    const entries = window.history.length;
    expect(showMailView("/mail/u/1/sent")).toBe(true);
    expect(window.location.pathname).toBe("/mail/u/1/sent");
    expect(window.history.length).toBe(entries + 1);
  });

  it("adds no entry for the view already shown", () => {
    const entries = window.history.length;
    expect(showMailView("/mail/u/1/inbox")).toBe(true);
    expect(window.history.length).toBe(entries);
  });

  it("leaves other accounts and other screens to the router", () => {
    expect(showMailView("/mail/u/0/sent")).toBe(false);
    expect(showMailView("/acc_b/home")).toBe(false);
    window.history.replaceState(null, "", "/acc_b/home");
    expect(showMailView("/mail/u/1/sent")).toBe(false);
    expect(window.location.pathname).toBe("/acc_b/home");
  });
});
