/** @vitest-environment jsdom */

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailCoverageGate } from "./MailEngineHost";

vi.mock("@/utils/actions/email-account-cookie", () => ({
  setLastEmailAccountAction: vi.fn(),
}));

beforeEach(() => {
  vi.stubGlobal("navigator", {
    ...navigator,
    storage: { getDirectory: async () => ({}) },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("MailCoverageGate", () => {
  it("holds a screen back until the mail engine is ready", async () => {
    await act(async () => {
      render(
        <MailCoverageGate fallback={<p>frame</p>}>
          <p>mail screen</p>
        </MailCoverageGate>,
      );
    });

    expect(screen.getByText("frame")).toBeTruthy();
    expect(screen.queryByText("mail screen")).toBeNull();
  });

  it("shows the mail screen while the engine starts when asked, so it never remounts", async () => {
    await act(async () => {
      render(
        <MailCoverageGate fallback={<p>frame</p>} showChildrenWhileStarting>
          <p>mail screen</p>
        </MailCoverageGate>,
      );
    });

    expect(screen.getByText("mail screen")).toBeTruthy();
    expect(screen.queryByText("frame")).toBeNull();
  });
});
