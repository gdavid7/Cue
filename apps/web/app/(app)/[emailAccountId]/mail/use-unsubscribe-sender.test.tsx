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
  swrOptions: undefined as
    | { refreshInterval?: (latest?: { filtersAvailable: boolean }) => number }
    | undefined,
  stats: {
    newsletters: [] as unknown[],
    searchedSenderStatus: null as string | null,
    filtersAvailable: true,
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
  default: (_key: unknown, options: typeof mocks.swrOptions) => {
    mocks.swrOptions = options;
    return {
      data: mocks.stats,
      mutate: vi.fn().mockResolvedValue(undefined),
      isLoading: false,
    };
  },
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
    mocks.setSenderStatusAction.mockResolvedValue({ data: {} });
    mocks.unsubscribeSenderAction.mockResolvedValue({
      data: { unsubscribe: { success: true } },
    });
  });
  afterEach(cleanup);

  it("asks again while the provider filters could not be read, and stops once they can", () => {
    renderHook(() => useUnsubscribeSender(message({})));
    const refreshInterval = mocks.swrOptions?.refreshInterval;

    expect(refreshInterval?.({ filtersAvailable: false })).toBeGreaterThan(0);
    expect(refreshInterval?.({ filtersAvailable: true })).toBe(0);
    expect(refreshInterval?.(undefined)).toBe(0);
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
