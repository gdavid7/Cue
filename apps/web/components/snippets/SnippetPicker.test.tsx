// @vitest-environment jsdom
import { createRef } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SnippetPicker,
  type SnippetPickerRef,
} from "@/components/snippets/SnippetPicker";

afterEach(cleanup);

const snippets = [{ id: "1", shortcut: "thanks", content: "Thanks!" }];

describe("SnippetPicker free times row", () => {
  it("is reachable from the keyboard without becoming the Enter default", () => {
    const onSelectFreeTimes = vi.fn();
    const onSelectSnippet = vi.fn();
    const ref = createRef<SnippetPickerRef>();
    render(
      <SnippetPicker
        onSelectAsk={vi.fn()}
        onSelectCreate={vi.fn()}
        onSelectFreeTimes={onSelectFreeTimes}
        onSelectSnippet={onSelectSnippet}
        query=""
        ref={ref}
        snippets={snippets}
      />,
    );

    expect(
      screen.getByRole("option", { name: /Share my free times/ }),
    ).toBeTruthy();
    // Enter still picks the first snippet, as before.
    expect(
      screen
        .getByRole("option", { name: /\/thanks/ })
        .getAttribute("aria-selected"),
    ).toBe("true");

    press(ref, "ArrowUp");
    press(ref, "ArrowUp");
    expect(
      screen
        .getByRole("option", { name: /Share my free times/ })
        .getAttribute("aria-selected"),
    ).toBe("true");
    press(ref, "Enter");

    expect(onSelectFreeTimes).toHaveBeenCalledTimes(1);
    expect(onSelectSnippet).not.toHaveBeenCalled();
  });

  it("steps aside when the query names something else", () => {
    render(
      <SnippetPicker
        onSelectCreate={vi.fn()}
        onSelectFreeTimes={vi.fn()}
        onSelectSnippet={vi.fn()}
        query="thanks"
        snippets={snippets}
      />,
    );

    expect(screen.queryByRole("option", { name: /Share my free times/ })).toBe(
      null,
    );
  });

  it("matches a query for it", () => {
    render(
      <SnippetPicker
        onSelectCreate={vi.fn()}
        onSelectFreeTimes={vi.fn()}
        onSelectSnippet={vi.fn()}
        query="free"
        snippets={snippets}
      />,
    );

    expect(
      screen.getByRole("option", { name: /Share my free times/ }),
    ).toBeTruthy();
  });
});

function press(ref: React.RefObject<SnippetPickerRef | null>, key: string) {
  act(() => {
    ref.current?.onKeyDown({
      event: new KeyboardEvent("keydown", { key, cancelable: true }),
    });
  });
}
