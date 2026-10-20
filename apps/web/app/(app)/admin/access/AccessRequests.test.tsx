/** @vitest-environment jsdom */

import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GoogleTestUsersReminder } from "@/app/(app)/admin/access/AccessRequests";

(globalThis as { React?: typeof React }).React = React;

vi.mock("server-only", () => ({}));
vi.mock("@/utils/actions/access", () => ({}));

describe("GoogleTestUsersReminder", () => {
  afterEach(cleanup);

  it("renders an unchecked reminder that can be ticked", () => {
    render(<GoogleTestUsersReminder />);

    const box = screen.getByRole("checkbox", {
      name: "Added to Google test users? (required while the Google app is in Testing mode)",
    });
    expect(box.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(box);
    expect(box.getAttribute("aria-checked")).toBe("true");
  });

  it("starts unchecked again after it is remounted, as when the dialog reopens", () => {
    const { unmount } = render(<GoogleTestUsersReminder />);
    fireEvent.click(screen.getByRole("checkbox"));
    unmount();

    render(<GoogleTestUsersReminder />);

    expect(screen.getByRole("checkbox").getAttribute("aria-checked")).toBe(
      "false",
    );
  });
});
