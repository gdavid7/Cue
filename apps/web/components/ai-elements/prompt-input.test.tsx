// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PromptInput,
  PromptInputSubmit,
  PromptInputTextarea,
} from "@/components/ai-elements/prompt-input";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("PromptInputSubmit", () => {
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

describe("PromptInputTextarea", () => {
  it("sends on Return with a hardware keyboard, and Shift+Return adds a line", () => {
    const { onSubmit, textarea } = renderPrompt({ coarsePointer: false });

    expect(pressReturn(textarea, { shiftKey: true })).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    expect(pressReturn(textarea)).toBe(false);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  // Phone keyboards have no Shift+Return, so Return sending would make a
  // multi-line message impossible.
  it("keeps Return as a newline on a touchscreen and sends from the button", () => {
    const { onSubmit, textarea } = renderPrompt({ coarsePointer: true });

    expect(pressReturn(textarea)).toBe(true);
    expect(onSubmit).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Send message" }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });
});

function renderPrompt({ coarsePointer }: { coarsePointer: boolean }) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: coarsePointer && query === "(pointer: coarse)",
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
  render(
    <PromptInput onSubmit={onSubmit}>
      <PromptInputTextarea aria-label="Message Cue" />
      <PromptInputSubmit status="ready" />
    </PromptInput>,
  );
  return { onSubmit, textarea: screen.getByLabelText("Message Cue") };
}

/** Whether the browser would go on to insert the newline. */
function pressReturn(target: HTMLElement, init: { shiftKey?: boolean } = {}) {
  return fireEvent.keyDown(target, { key: "Enter", ...init });
}
