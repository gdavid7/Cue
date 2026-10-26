/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useUnsubscribeSender } from "@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender";
import type { ParsedMessage } from "@/utils/types";

(globalThis as { React?: typeof React }).React = React;

const mocks = vi.hoisted(() => ({
  toastUndo: vi.fn(),
  setSenderStatusAction: vi.fn(),
  unsubscribeSenderAction: vi.fn(),
  keys: [] as string[],
  passiveLoading: false,
  askedStats: undefined as typeof mocks.stats | undefined,
  askedMutate: vi.fn(),
  stats: {
    newsletters: [] as unknown[],
    searchedSenderStatus: null as string | null,
    filtersAvailable: true,
    filtersFailure: undefined as string | undefined,
  },
}));

vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), {
    loading: vi.fn(() => "toast-id"),
    success: vi.fn(),
    error: vi.fn(),
    dismiss: vi.fn(),
  }),
}));
vi.mock("swr", () => ({
  default: (key: unknown) => {
    const interactive =
      Array.isArray(key) && String(key[0]).includes("interactive=true");
    if (Array.isArray(key)) mocks.keys.push(String(key[0]));
    return {
      data: interactive ? mocks.askedStats : mocks.stats,
      mutate: interactive
        ? mocks.askedMutate
        : vi.fn().mockResolvedValue(undefined),
      isLoading: interactive ? false : mocks.passiveLoading,
    };
  },
  useSWRConfig: () => ({ mutate: vi.fn() }),
}));
vi.mock("@/components/Toast", () => ({ toastUndo: mocks.toastUndo }));
vi.mock("@/app/(app)/premium/PremiumModal", () => ({
  usePremiumModal: () => ({ PremiumModal: () => null, openModal: vi.fn() }),
}));
vi.mock("@/hooks/usePremium", () => ({
  usePremium: () => ({ hasUnsubscribeAccess: true, mutate: vi.fn() }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "account-1" }),
}));
vi.mock("@/store/archive-sender-queue", () => ({
  useArchiveSenderQueueActions: () => ({
    queueArchiveSenders: vi.fn().mockResolvedValue(undefined),
  }),
}));
vi.mock("@/utils/actions/premium", () => ({
  decrementUnsubscribeCreditAction: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/utils/actions/unsubscriber", () => ({
  setSenderStatusAction: mocks.setSenderStatusAction,
  unsubscribeSenderAction: mocks.unsubscribeSenderAction,
}));

describe("useUnsubscribeSender", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stats.searchedSenderStatus = null;
    mocks.stats.filtersAvailable = true;
    mocks.stats.filtersFailure = undefined;
    mocks.keys = [];
    mocks.passiveLoading = false;
    mocks.askedStats = undefined;
    mocks.askedMutate = vi.fn().mockResolvedValue(undefined);
    mocks.setSenderStatusAction.mockResolvedValue({ data: {} });
    mocks.unsubscribeSenderAction.mockResolvedValue({
      data: { unsubscribe: { success: true } },
    });
  });
  afterEach(cleanup);

  it("asks Gmail ahead of background work only when the person asks, and not after a refused grant", () => {
    mocks.stats.filtersAvailable = false;
    mocks.stats.filtersFailure = "permanent";
    const { result } = renderHook(() => useUnsubscribeSender(message({})));
    act(() => result.current.loadSenderFilters());
    expect(askedInteractively()).toBe(false);

    mocks.stats.filtersFailure = "throttled";
    const { result: second } = renderHook(() =>
      useUnsubscribeSender(message({})),
    );
    expect(askedInteractively()).toBe(false);
    act(() => second.current.loadSenderFilters());
    expect(askedInteractively()).toBe(true);
  });

  it("does not ask while the passive read is still loading", () => {
    mocks.stats.filtersAvailable = false;
    mocks.stats.filtersFailure = "throttled";
    mocks.passiveLoading = true;
    const { result } = renderHook(() => useUnsubscribeSender(message({})));

    act(() => result.current.loadSenderFilters());

    expect(askedInteractively()).toBe(false);
  });

  it("does not ask Gmail again for 15 seconds after it refused the asked-for read", () => {
    vi.useFakeTimers();
    mocks.stats.filtersAvailable = false;
    mocks.stats.filtersFailure = "throttled";
    const { result, rerender } = renderHook(() =>
      useUnsubscribeSender(message({})),
    );
    act(() => result.current.loadSenderFilters());
    mocks.askedStats = { ...mocks.stats };
    rerender();

    vi.advanceTimersByTime(5000);
    act(() => result.current.loadSenderFilters());
    expect(mocks.askedMutate).not.toHaveBeenCalled();

    vi.advanceTimersByTime(11_000);
    act(() => result.current.loadSenderFilters());
    expect(mocks.askedMutate).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("offers undo after blocking a sender and restores the inbox on undo", async () => {
    const { result } = renderHook(() => useUnsubscribeSender(message({})));

    await act(() => result.current.onUnsubscribe());

    expect(mocks.setSenderStatusAction).toHaveBeenCalledWith("account-1", {
      senderEmail: "news@example.com",
      status: "AUTO_ARCHIVED",
    });
    expect(mocks.toastUndo).toHaveBeenCalledTimes(1);

    await act(() => mocks.toastUndo.mock.calls[0][0].onUndo());

    expect(mocks.setSenderStatusAction).toHaveBeenLastCalledWith("account-1", {
      senderEmail: "news@example.com",
      status: null,
    });
  });

  it("puts the previous status back on undo and keeps its own toast id", async () => {
    mocks.stats.searchedSenderStatus = "APPROVED";
    const { result } = renderHook(() => useUnsubscribeSender(message({})));

    await act(() => result.current.onUnsubscribe());
    expect(mocks.toastUndo.mock.calls[0][0].id).toBe("block-sender-undo");
    await act(() => mocks.toastUndo.mock.calls[0][0].onUndo());

    expect(mocks.setSenderStatusAction).toHaveBeenLastCalledWith("account-1", {
      senderEmail: "news@example.com",
      status: "APPROVED",
    });
  });

  it("shows one undo toast when the action fires twice in the same tick", async () => {
    const { result } = renderHook(() => useUnsubscribeSender(message({})));

    await act(async () => {
      await Promise.all([
        result.current.onUnsubscribe(),
        result.current.onUnsubscribe(),
      ]);
    });

    expect(mocks.setSenderStatusAction).toHaveBeenCalledTimes(1);
    expect(mocks.toastUndo).toHaveBeenCalledTimes(1);
  });

  it("asks before sending a one-click unsubscribe it cannot take back", async () => {
    const { result } = renderHook(() =>
      useUnsubscribeSender(
        message({ "list-unsubscribe": "<https://example.com/u?id=1>" }),
      ),
    );

    await act(() => result.current.onUnsubscribe());

    expect(result.current.unsubscribeConfirm.open).toBe(true);
    expect(mocks.unsubscribeSenderAction).not.toHaveBeenCalled();

    await act(() => result.current.unsubscribeConfirm.onConfirm());

    expect(mocks.unsubscribeSenderAction).toHaveBeenCalledTimes(1);
  });
});

function message(headers: Record<string, string>) {
  return {
    threadId: "thread-1",
    headers: { from: "News <news@example.com>", ...headers },
  } as Pick<ParsedMessage, "headers" | "threadId">;
}

function askedInteractively() {
  return mocks.keys.some((key) => key.includes("interactive=true"));
}
