/** @vitest-environment jsdom */

import { act, cleanup, screen } from "@testing-library/react";
import { hydrateRoot } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { EmailDate } from "./EmailDate";

afterEach(cleanup);

const DATE = new Date("2026-03-14T12:00:00.000Z");

describe("EmailDate", () => {
  it("leaves the date out of server HTML, which knows no viewer's timezone", () => {
    expect(renderToString(<EmailDate date={DATE} />)).not.toMatch(/mar/i);
  });

  it("hydrates without a mismatch and then shows the date", async () => {
    const container = document.createElement("div");
    container.innerHTML = renderToString(<EmailDate date={DATE} />);
    document.body.append(container);
    const recoverable = vi.fn();

    await act(async () => {
      hydrateRoot(container, <EmailDate date={DATE} />, {
        onRecoverableError: recoverable,
      });
    });

    expect(recoverable).not.toHaveBeenCalled();
    expect(screen.getByText(/mar 14/i)).toBeTruthy();
  });
});
