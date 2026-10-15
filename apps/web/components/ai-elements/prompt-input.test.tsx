// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PromptInputSubmit } from "@/components/ai-elements/prompt-input";

describe("PromptInputSubmit", () => {
  afterEach(cleanup);

  // The button shows only an icon, and while Cue answers it is the one way
  // to stop the answer, so assistive tech needs a name that says which.
  it("is named for what pressing it does", () => {
    const { rerender } = render(<PromptInputSubmit status="ready" />);
    expect(screen.getByRole("button", { name: "Send message" })).toBeTruthy();

    rerender(<PromptInputSubmit status="submitted" />);
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeTruthy();

    rerender(<PromptInputSubmit status="streaming" />);
    expect(
      screen.getByRole("button", { name: "Stop generating" }),
    ).toBeTruthy();
  });
});
