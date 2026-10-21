// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Tooltip } from "./Tooltip";

afterEach(cleanup);

describe("Tooltip", () => {
  it("keeps its trigger mounted when hidden, so focus on it survives", () => {
    const { rerender } = render(
      <Tooltip content="Send now">
        <button type="button">Send</button>
      </Tooltip>,
    );
    const button = screen.getByRole("button", { name: "Send" });
    button.focus();

    rerender(
      <Tooltip content="Send now" hide>
        <button type="button">Send</button>
      </Tooltip>,
    );

    expect(screen.getByRole("button", { name: "Send" })).toBe(button);
    expect(document.activeElement).toBe(button);
  });
});
