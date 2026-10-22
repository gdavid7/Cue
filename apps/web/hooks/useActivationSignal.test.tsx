// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { action } = vi.hoisted(() => ({ action: vi.fn() }));

vi.mock("@/utils/actions/activation", () => ({
  recordActivationSignalAction: action,
}));

describe("activation signals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    window.localStorage.clear();
    action.mockResolvedValue({});
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it.each([
    "first_sync_ready",
    "first_thread_opened",
    "first_triage_action",
  ] as const)("fires %s once per mailbox, however often it re-renders", async (event) => {
    const { useActivationSignal } = await load();
    const mailbox = `mailbox-${event}`;
    const { rerender } = renderHook(
      ({ happened }) => useActivationSignal(mailbox, event, happened),
      { initialProps: { happened: false } },
    );
    await flush();
    expect(action).not.toHaveBeenCalled();

    rerender({ happened: true });
    rerender({ happened: true });
    rerender({ happened: false });
    rerender({ happened: true });
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledWith(mailbox, { event });
  });

  it("does not report again after a reload once the server has taken it", async () => {
    const first = await load();
    first.reportActivationSignal("mailbox-reload", "first_sync_ready");
    await flush();
    expect(action).toHaveBeenCalledTimes(1);

    const reloaded = await load();
    reloaded.reportActivationSignal("mailbox-reload", "first_sync_ready");
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("still reports other mailboxes and other events after a reload", async () => {
    const first = await load();
    first.reportActivationSignal("mailbox-a", "first_sync_ready");
    await flush();

    const reloaded = await load();
    reloaded.reportActivationSignal("mailbox-b", "first_sync_ready");
    reloaded.reportActivationSignal("mailbox-a", "first_thread_opened");
    await flush();

    expect(action).toHaveBeenCalledTimes(3);
  });

  it("stays unreported when the server answers with an error, and retries", async () => {
    const { reportActivationSignal } = await load();
    action.mockResolvedValueOnce({ serverError: "Unauthorized" });
    reportActivationSignal("mailbox-err", "first_triage_action");
    await flush();

    reportActivationSignal("mailbox-err", "first_triage_action");
    await flush();

    expect(action).toHaveBeenCalledTimes(2);
    const reloaded = await load();
    reloaded.reportActivationSignal("mailbox-err", "first_triage_action");
    await flush();
    expect(action).toHaveBeenCalledTimes(2);
  });

  it("retries in the same session after the call fails", async () => {
    const { reportActivationSignal } = await load();
    action.mockRejectedValueOnce(new Error("offline"));
    reportActivationSignal("mailbox-down", "first_sync_ready");
    await flush();

    reportActivationSignal("mailbox-down", "first_sync_ready");
    await flush();

    expect(action).toHaveBeenCalledTimes(2);
  });

  it("sends one call while the first is still in flight", async () => {
    const { reportActivationSignal } = await load();
    let settle = () => {};
    action.mockReturnValueOnce(
      new Promise((resolve) => {
        settle = () => resolve({});
      }),
    );
    reportActivationSignal("mailbox-slow", "first_sync_ready");
    await flush();
    reportActivationSignal("mailbox-slow", "first_sync_ready");
    await flush();
    settle();
    await flush();

    expect(action).toHaveBeenCalledTimes(1);
  });

  it("defers the call so it doesn't queue ahead of the user's own actions", async () => {
    const { reportActivationSignal } = await load();

    reportActivationSignal("mailbox-late", "first_thread_opened");
    expect(action).not.toHaveBeenCalled();

    await flush();
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("does not fire without a mailbox", async () => {
    const { useActivationSignal } = await load();
    renderHook(() =>
      useActivationSignal(undefined, "first_thread_opened", true),
    );
    await flush();

    expect(action).not.toHaveBeenCalled();
  });

  it("works when storage is blocked, reporting once per page session", async () => {
    const { reportActivationSignal } = await load();
    const blocked = vi
      .spyOn(Storage.prototype, "setItem")
      .mockImplementation(() => {
        throw new Error("blocked");
      });
    try {
      reportActivationSignal("mailbox-blocked", "first_sync_ready");
      await flush();
      reportActivationSignal("mailbox-blocked", "first_sync_ready");
      await flush();
    } finally {
      blocked.mockRestore();
    }

    expect(action).toHaveBeenCalledTimes(1);
  });

  // A fresh module is a fresh page load: its in-memory state starts empty.
  async function load() {
    vi.resetModules();
    const cache = await import("@/utils/browser-cache");
    cache.resetBrowserCacheForTesting();
    return import("./useActivationSignal");
  }

  async function flush() {
    await vi.advanceTimersByTimeAsync(3000);
  }
});
