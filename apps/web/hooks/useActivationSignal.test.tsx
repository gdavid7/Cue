// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  reportActivationSignal,
  useActivationSignal,
} from "./useActivationSignal";

const { action } = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock("@/utils/actions/activation", () => ({
  recordActivationSignalAction: action,
}));

describe("activation signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    action.mockResolvedValue({});
  });

  it.each([
    "first_sync_ready",
    "first_thread_opened",
    "first_triage_action",
  ] as const)("fires %s once per mailbox, however often it re-renders", (event) => {
    const { rerender } = renderHook(
      ({ happened }) =>
        useActivationSignal(`mailbox-${event}`, event, happened),
      { initialProps: { happened: false } },
    );
    expect(action).not.toHaveBeenCalled();

    rerender({ happened: true });
    rerender({ happened: true });
    rerender({ happened: false });
    rerender({ happened: true });

    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(`mailbox-${event}`, { event });
  });

  it("fires again for another mailbox", () => {
    reportActivationSignal("mailbox-a", "first_triage_action");
    reportActivationSignal("mailbox-a", "first_triage_action");
    reportActivationSignal("mailbox-b", "first_triage_action");

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("does not fire without a mailbox", () => {
    renderHook(() =>
      useActivationSignal(undefined, "first_thread_opened", true),
    );

    expect(action).not.toHaveBeenCalled();
  });

  it("swallows a failed report", async () => {
    action.mockRejectedValue(new Error("offline"));

    expect(() =>
      reportActivationSignal("mailbox-3", "first_sync_ready"),
    ).not.toThrow();
    await Promise.resolve();
  });
});
