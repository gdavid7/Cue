/** @vitest-environment jsdom */

import React from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorsList } from "@/components/connectors/ConnectorsList";

(globalThis as { React?: typeof React }).React = React;

const mockUseIntegrations = vi.fn();

vi.mock("@/hooks/useIntegrations", () => ({
  useIntegrations: () => mockUseIntegrations(),
}));

describe("ConnectorsList", () => {
  afterEach(() => {
    cleanup();
    mockUseIntegrations.mockReset();
  });

  it("asks to reconnect an app whose access lapsed, and shows a paused one as paused", () => {
    mockUseIntegrations.mockReturnValue({
      data: {
        integrations: [
          integration("googledrive", { needsReconnect: true }),
          integration("canvas", { isActive: false }),
          integration("slack", {}),
        ],
      },
    });

    render(<ConnectorsList emailAccountId="account-1" />);

    expect(
      screen.getByRole("link", { name: /Google Drive.*Reconnect/ }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: /Canvas.*Paused/ })).toBeTruthy();
    expect(screen.getByRole("link", { name: /Slack.*Connected/ })).toBeTruthy();
  });
});

function integration(
  name: string,
  { isActive = true, needsReconnect = false },
) {
  return {
    name,
    connection: { isActive, needsReconnect, connectedVia: null },
  };
}
