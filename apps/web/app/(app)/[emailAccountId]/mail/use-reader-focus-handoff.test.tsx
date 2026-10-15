// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
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

  // A request belongs to the conversation it was made for; a later one
  // showing must not take focus on its behalf.
  it("drops the request when another conversation opens first", () => {
    const { rerender } = render(<Shell loaded={false} />);
    screen.getByRole("option", { name: "First" }).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });

    fireEvent.keyDown(document.body, { key: "j" });
    rerender(<Shell loaded />);

    expect(document.activeElement).toBe(document.body);
  });

  it("waits for the address to name the conversation it opened", () => {
    const { rerender } = render(<Shell addressKey={null} loaded />);
    screen.getByRole("option", { name: "Second" }).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    expect(document.activeElement).toBe(document.body);

    rerender(<Shell addressKey="Second" loaded />);

    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Second" }),
    );
  });

  it("drops the request when the list comes back empty", () => {
    const { rerender } = render(<Shell loaded />);
    screen.getByRole("option", { name: "Second" }).focus();
    fireEvent.keyDown(document.activeElement as Element, { key: "Enter" });
    rerender(<Shell loaded subjects={[]} />);

    fireEvent.click(screen.getByRole("button", { name: "Back to inbox" }));
    rerender(<Shell loaded />);

    expect(document.activeElement).toBe(document.body);
  });
});

const SUBJECTS = ["First", "Second"];

function Shell({
  loaded,
  autoFocusReply = false,
  subjects = SUBJECTS,
  addressKey,
}: {
  loaded: boolean;
  autoFocusReply?: boolean;
  subjects?: string[];
  /** The open key as the address reports it, when it lags the state. */
  addressKey?: string | null;
}) {
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [isOpen, setIsOpen] = useState(false);
  const stateKey = isOpen ? (SUBJECTS[focusedIndex] ?? null) : null;
  const openKey = addressKey === undefined ? stateKey : addressKey;
  const { listRef, readerRef, focusReaderWhenShown, focusListWhenShown } =
    useReaderFocusHandoff(openKey);

  // Stands in for J, which moves the open reader to the next conversation.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "j") setFocusedIndex((index) => index + 1);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  if (!isOpen) {
    return (
      <section ref={listRef}>
        <div aria-label="Conversations" role="listbox">
          {subjects.map((subject, index) => (
            <div
              aria-selected={false}
              data-mail-thread-row
              key={subject}
              onFocus={() => setFocusedIndex(index)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                focusReaderWhenShown(subject);
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
