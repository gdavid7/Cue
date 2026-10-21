// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreSendConfirmation } from "./PreSendConfirmation";
import type { PreSendWarning } from "./pre-send-warnings";

afterEach(cleanup);

const WARNINGS: PreSendWarning[] = [
  {
    id: "missing-attachment",
    message: "The message mentions an attachment, but nothing is attached.",
    fix: "attach",
  },
  {
    id: "no-subject",
    message: "This message has no subject.",
    fix: "subject",
  },
];

function renderConfirmation() {
  const handlers = { onSend: vi.fn(), onFix: vi.fn(), onDismiss: vi.fn() };
  render(
    <form>
      <textarea aria-label="Body" />
      <input
        aria-controls="suggestions"
        aria-expanded="true"
        aria-label="To"
        role="combobox"
      />
      <div id="suggestions" role="listbox" />
      <PreSendConfirmation warnings={WARNINGS} {...handlers} />
    </form>,
  );
  return handlers;
}

describe("PreSendConfirmation", () => {
  it("lists every warning and takes focus on Send anyway", () => {
    renderConfirmation();
    const group = screen.getByRole("group", { name: "Before you send" });
    for (const warning of WARNINGS)
      expect(group.textContent).toContain(warning.message);
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Send anyway" }),
    );
  });

  it("sends on Enter and on click", () => {
    const { onSend, onDismiss } = renderConfirmation();
    fireEvent.keyDown(screen.getByRole("button", { name: "Send anyway" }), {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("button", { name: "Send anyway" }));
    expect(onSend).toHaveBeenCalledTimes(2);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("goes back to the draft on Escape, even from the message body", () => {
    const { onSend, onDismiss } = renderConfirmation();
    fireEvent.keyDown(screen.getByRole("button", { name: "Send anyway" }), {
      key: "Escape",
    });
    fireEvent.keyDown(screen.getByLabelText("Body"), { key: "Escape" });
    expect(onDismiss).toHaveBeenCalledTimes(2);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("leaves Escape to an open list of suggestions in the composer", () => {
    const { onDismiss } = renderConfirmation();
    fireEvent.keyDown(screen.getByRole("combobox", { name: "To" }), {
      key: "Escape",
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("leaves an Escape something else already handled", () => {
    const { onDismiss } = renderConfirmation();
    const handled = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    handled.preventDefault();
    screen.getByLabelText("Body").dispatchEvent(handled);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it("offers the fix for the first warning, which Enter on it runs rather than sending", () => {
    const { onSend, onFix } = renderConfirmation();
    const fix = screen.getByRole("button", { name: "Attach files" });
    fireEvent.keyDown(fix, { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
    fireEvent.click(fix);
    expect(onFix).toHaveBeenCalledWith("attach");
  });

  it("leaves Enter typed in the message alone", () => {
    const { onSend } = renderConfirmation();
    fireEvent.keyDown(screen.getByLabelText("Body"), { key: "Enter" });
    expect(onSend).not.toHaveBeenCalled();
  });
});
