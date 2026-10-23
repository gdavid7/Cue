// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EmailEditorHandle } from "@inboxzero/email-editor/web";
import { useShareFreeTimes } from "./useShareFreeTimes";

const mocks = vi.hoisted(() => ({
  fetchWithAccount: vi.fn(),
  toastError: vi.fn(),
  toastInfo: vi.fn(),
}));

vi.mock("@/utils/fetch", () => ({ fetchWithAccount: mocks.fetchWithAccount }));
vi.mock("@/components/Toast", () => ({
  toastError: mocks.toastError,
  toastInfo: mocks.toastInfo,
}));

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("useShareFreeTimes", () => {
  it("gives up after 15 seconds, inserts nothing, and can be asked again", async () => {
    const timeout = new AbortController();
    const timeoutSpy = vi
      .spyOn(AbortSignal, "timeout")
      .mockReturnValue(timeout.signal);
    // A calendar read that never answers on its own.
    mocks.fetchWithAccount.mockImplementation(
      ({ init }: { init: RequestInit }) =>
        new Promise((_, reject) => {
          init.signal?.addEventListener("abort", () =>
            reject(new DOMException("timed out", "TimeoutError")),
          );
        }),
    );
    const insertHtml = vi.fn();
    const editorRef = {
      current: { insertHtml } as unknown as EmailEditorHandle,
    };
    const { result } = renderHook(() =>
      useShareFreeTimes({ editorRef, emailAccountId: "account" }),
    );

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.shareFreeTimes();
    });
    expect(result.current.isLoading).toBe(true);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);

    await act(async () => {
      timeout.abort();
      await pending;
    });

    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "Couldn't read your calendar, so no times were added.",
      }),
    );
    expect(insertHtml).not.toHaveBeenCalled();
    expect(result.current.isLoading).toBe(false);

    // Not stuck "in flight": the next press reads the calendar again.
    mocks.fetchWithAccount.mockResolvedValue(
      Response.json({ status: "no-calendar", bookingLink: null }),
    );
    await act(async () => {
      await result.current.shareFreeTimes();
    });
    expect(mocks.fetchWithAccount).toHaveBeenCalledTimes(2);
  });
});
