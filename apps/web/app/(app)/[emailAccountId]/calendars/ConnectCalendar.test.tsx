/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxProvidersProvider } from "@/providers/MailboxProvidersProvider";
import type { MailboxProvider } from "@/utils/oauth/provider-config";
import { ConnectCalendar } from "./ConnectCalendar";

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));
vi.mock("@/hooks/useProductAnalytics", () => ({
  useProductAnalytics: () => ({ captureAction: vi.fn() }),
}));

(globalThis as { React?: typeof React }).React = React;

describe("ConnectCalendar", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers both calendars when both providers are configured", () => {
    renderConnectCalendar(["google", "microsoft"]);

    expect(
      screen.getByRole("button", { name: /add google calendar/i }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: /add outlook calendar/i }),
    ).toBeTruthy();
  });

  it("hides Outlook Calendar when Microsoft OAuth is not configured", () => {
    renderConnectCalendar(["google"]);

    expect(
      screen.getByRole("button", { name: /add google calendar/i }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: /add outlook calendar/i }),
    ).toBeNull();
  });
});

function renderConnectCalendar(enabledProviders: MailboxProvider[]) {
  return render(
    <MailboxProvidersProvider enabledProviders={enabledProviders}>
      <ConnectCalendar />
    </MailboxProvidersProvider>,
  );
}
