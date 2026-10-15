/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MailboxProvidersProvider } from "@/providers/MailboxProvidersProvider";
import type { MailboxProvider } from "@/utils/oauth/provider-config";

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
    renderAddAccount(<AddAccount />);

    expect(screen.getByText(/billed for each account/i)).toBeTruthy();
  });

  it("hides billing copy when premium checks are bypassed", () => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;

    renderAddAccount(<AddAccount />);

    expect(screen.queryByText(/billed/i)).toBeNull();
    expect(screen.getByRole("button", { name: /add google/i })).toBeTruthy();
  });

  it("keeps custom helper text when premium checks are bypassed", () => {
    envMock.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS = true;

    renderAddAccount(
      <AddAccount helperText="You can add more mailboxes later." />,
    );

    expect(screen.getByText("You can add more mailboxes later.")).toBeTruthy();
  });

  it("offers both providers when both are configured", () => {
    renderAddAccount(<AddAccount />, ["google", "microsoft"]);

    expect(screen.getByRole("button", { name: /add google/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /add microsoft/i })).toBeTruthy();
  });

  it("hides Add Microsoft when Microsoft OAuth is not configured", () => {
    renderAddAccount(<AddAccount />, ["google"]);

    expect(screen.getByRole("button", { name: /add google/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add microsoft/i })).toBeNull();
  });

  it("hides Add Google when Google OAuth is not configured", () => {
    renderAddAccount(<AddAccount />, ["microsoft"]);

    expect(screen.queryByRole("button", { name: /add google/i })).toBeNull();
    expect(screen.getByRole("button", { name: /add microsoft/i })).toBeTruthy();
  });
});

function renderAddAccount(
  ui: React.ReactElement,
  enabledProviders: MailboxProvider[] = ["google", "microsoft"],
) {
  return render(
    <MailboxProvidersProvider enabledProviders={enabledProviders}>
      {ui}
    </MailboxProvidersProvider>,
  );
}
