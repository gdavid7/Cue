/** @vitest-environment jsdom */

import React from "react";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectWithCredentialsDialog } from "@/components/connectors/ConnectWithCredentialsDialog";

(globalThis as { React?: typeof React }).React = React;

const { mockExecuteAsync, mockToastSuccess } = vi.hoisted(() => ({
  mockExecuteAsync: vi.fn(),
  mockToastSuccess: vi.fn(),
}));

vi.mock("next-safe-action/hooks", () => ({
  useAction: () => ({ executeAsync: mockExecuteAsync, isExecuting: false }),
}));
vi.mock("@/utils/actions/mcp", () => ({
  connectWithCredentialsAction: { bind: () => vi.fn() },
}));
vi.mock("@/components/Toast", () => ({
  toastSuccess: mockToastSuccess,
  toastError: vi.fn(),
}));

describe("ConnectWithCredentialsDialog", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("says in the form why Canvas didn't take the token, and stays open", async () => {
    mockExecuteAsync.mockResolvedValue({
      serverError: "Canvas rejected this token. Check it or create a new one.",
    });
    const onOpenChange = vi.fn();
    const onConnected = vi.fn();
    renderDialog({ onOpenChange, onConnected });

    fillAndSubmit();

    expect((await screen.findByRole("alert")).textContent).toBe(
      "Canvas rejected this token. Check it or create a new one.",
    );
    expect(onOpenChange).not.toHaveBeenCalledWith(false);
    expect(onConnected).not.toHaveBeenCalled();
  });

  it("says whose Canvas account it connected", async () => {
    mockExecuteAsync.mockResolvedValue({ data: { name: "Ada Lovelace" } });
    const onConnected = vi.fn();
    renderDialog({ onConnected });

    fillAndSubmit();

    await waitFor(() => expect(onConnected).toHaveBeenCalled());
    expect(mockToastSuccess).toHaveBeenCalledWith({
      description: "Connected as Ada Lovelace",
    });
  });

  it("titles the form for reconnecting when the token stopped working", () => {
    renderDialog({ reconnect: true });

    expect(
      screen.getByRole("heading", { name: "Reconnect Canvas" }),
    ).toBeTruthy();
  });
});

function renderDialog({
  onOpenChange = vi.fn(),
  onConnected = vi.fn(),
  reconnect = false,
}: {
  onOpenChange?: (open: boolean) => void;
  onConnected?: () => void;
  reconnect?: boolean;
}) {
  render(
    <ConnectWithCredentialsDialog
      displayName="Canvas"
      emailAccountId="account-1"
      fields={[
        {
          name: "full",
          label: "Canvas address",
          description: "",
          kind: "url",
        },
        {
          name: "generic_api_key",
          label: "Access token",
          description: "",
          secret: true,
        },
      ]}
      integration="canvas"
      onConnected={onConnected}
      onOpenChange={onOpenChange}
      open
      reconnect={reconnect}
    />,
  );
}

function fillAndSubmit() {
  fireEvent.change(screen.getByLabelText("Canvas address"), {
    target: { value: "canvas.eee.uci.edu" },
  });
  fireEvent.change(screen.getByLabelText("Access token"), {
    target: { value: "test-canvas-token" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect" }));
}
