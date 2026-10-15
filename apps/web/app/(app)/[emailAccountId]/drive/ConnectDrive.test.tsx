/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxProvidersProvider } from "@/providers/MailboxProvidersProvider";
import type { MailboxProvider } from "@/utils/oauth/provider-config";
import { ConnectDrive } from "./ConnectDrive";

vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));

(globalThis as { React?: typeof React }).React = React;

describe("ConnectDrive", () => {
  afterEach(() => {
    cleanup();
  });

  it("offers both drives when both providers are configured", () => {
    renderConnectDrive(["google", "microsoft"]);

    expect(
      screen.getByRole("button", { name: /add google drive/i }),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: /add onedrive/i })).toBeTruthy();
  });

  it("hides OneDrive when Microsoft OAuth is not configured", () => {
    renderConnectDrive(["google"]);

    expect(
      screen.getByRole("button", { name: /add google drive/i }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: /add onedrive/i })).toBeNull();
  });
});

function renderConnectDrive(enabledProviders: MailboxProvider[]) {
  return render(
    <MailboxProvidersProvider enabledProviders={enabledProviders}>
      <ConnectDrive />
    </MailboxProvidersProvider>,
  );
}
