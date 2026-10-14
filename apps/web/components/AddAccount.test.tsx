/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { envMock } = vi.hoisted(() => ({
  envMock: { NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: false as boolean | undefined },
}));

vi.mock("@/env", () => ({ env: envMock }));

import { AddAccount } from "./AddAccount";

(globalThis as { React?: typeof React }).React = React;

describe("AddAccount", () => {
  beforeEach(() => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = false;
  });

  afterEach(() => {
    cleanup();
  });

  it("explains per-account billing when billing applies", () => {
    render(<AddAccount />);

    expect(screen.getByText(/billed for each account/i)).toBeTruthy();
  });

  it("hides billing copy when premium checks are bypassed", () => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;

    render(<AddAccount />);

    expect(screen.queryByText(/billed/i)).toBeNull();
    expect(screen.getByRole("button", { name: /add google/i })).toBeTruthy();
  });

  it("keeps custom helper text when premium checks are bypassed", () => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;

    render(<AddAccount helperText="You can add more mailboxes later." />);

    expect(screen.getByText("You can add more mailboxes later.")).toBeTruthy();
  });
});
