// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { useReaderFocusHandoff } from "@/app/(app)/[emailAccountId]/mail/use-reader-focus-handoff";

describe("useReaderFocusHandoff", () => {
  afterEach(cleanup);

  it("focuses the subject once the conversation shows, and the row on return", () => {
    const { rerender } = render(<Shell loaded={false} />);
    screen.getByRole("option", { name: "Second" }).focus();

    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(document.activeElement).toBe(document.body);

    rerender(<Shell loaded />);
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Second" }),
    );

    fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
    expect(document.activeElement).toBe(
      screen.getByRole("option", { name: "Second" }),
    );
  });

  it("leaves focus on whatever took it while the reader opened", () => {
    render(<Shell autoFocusReply loaded />);
    screen.getByRole("option", { name: "First" }).focus();

    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });

    expect(document.activeElement).toBe(
      screen.getByRole("textbox", { name: "Reply" }),
    );
  });
});

const SUBJECTS = ["First", "Second"];

function Shell({
  loaded,
  autoFocusReply = false,
}: {
  loaded: boolean;
  autoFocusReply?: boolean;
}) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const { listRef, readerRef, focusReaderWhenShown, focusListWhenShown } =
    useReaderFocusHandoff();

  if (!isOpen) {
    return (
      <section ref={listRef}>
        <div aria-label="Conversations" role="listbox">
          {SUBJECTS.map((subject, index) => (
            <div
              aria-selected={false}
              data-mail-thread-row
              key={subject}
              onFocus={() => setFocusedIndex(index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                focusReaderWhenShown();
                setIsOpen(true);
              }}
              role="option"
              tabIndex={index === focusedIndex ? 0 : -1}
            >
              {subject}
            </div>
          ))}
        </div>
      </section>
    );
  }

  return (
    <div ref={readerRef}>
      <button
        onClick={() => {
          focusListWhenShown();
          setIsOpen(false);
        }}
        type="button"
      >
        Back to inbox
      </button>
      {loaded ? (
        <h1 data-mail-reader-subject tabIndex={-1}>
          {SUBJECTS[focusedIndex]}
        </h1>
      ) : null}
      {/* Stands in for an auto-opened reply. */}
      {autoFocusReply ? <textarea aria-label="Reply" autoFocus /> : null}
    </div>
  );
}
