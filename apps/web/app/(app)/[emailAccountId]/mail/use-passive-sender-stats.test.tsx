/** @vitest-environment jsdom */

import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { SWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { usePassiveSenderStats } from "@/app/(app)/[emailAccountId]/mail/use-unsubscribe-sender";

(globalThis as { React?: typeof React }).React = React;

vi.mock("sonner", () => ({ toast: vi.fn() }));
vi.mock("@/components/Toast", () => ({ toastUndo: vi.fn() }));
vi.mock("@/app/(app)/premium/PremiumModal", () => ({
  usePremiumModal: () => ({ PremiumModal: () => null, openModal: vi.fn() }),
}));
vi.mock("@/hooks/usePremium", () => ({
  usePremium: () => ({ hasUnsubscribeAccess: true, mutate: vi.fn() }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ emailAccountId: "a" }),
}));
vi.mock("@/store/archive-sender-queue", () => ({
  useArchiveSenderQueueActions: () => ({ queueArchiveSenders: vi.fn() }),
}));
vi.mock("@/utils/actions/premium", () => ({
  decrementUnsubscribeCreditAction: vi.fn(),
}));
vi.mock("@/utils/actions/unsubscriber", () => ({
  setSenderStatusAction: vi.fn(),
  unsubscribeSenderAction: vi.fn(),
}));

let reads = 0;
let failure: "error" | "throttled" | undefined;
let urlNumber = 0;

describe("usePassiveSenderStats", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    reads = 0;
    failure = "error";
    urlNumber += 1;
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("asks again at 5s, 15s and 45s after a failing read, however often it renders", async () => {
    const { rerender } = renderHook(() => usePassiveSenderStats(url(), "a"), {
      wrapper,
    });
    await settle(0);
    for (let render = 0; render < 20; render++) rerender();
    await settle(0);
    expect(reads).toBe(1);

    await settle(5000);
    expect(reads).toBe(2);
    for (let render = 0; render < 20; render++) rerender();
    await settle(14_000);
    expect(reads).toBe(2);
    await settle(1000);
    expect(reads).toBe(3);
    await settle(45_000);
    expect(reads).toBe(4);
    await settle(10 * 60_000);
    expect(reads).toBe(4);
  });

  it("shares one retry budget between readers of the same sender", async () => {
    renderHook(
      () => {
        usePassiveSenderStats(url(), "a");
        usePassiveSenderStats(url(), "a");
        return usePassiveSenderStats(url(), "a");
      },
      { wrapper },
    );
    await settle(0);
    await settle(10 * 60_000);

    expect(reads).toBe(4);
  });

  it("does not ask again when Gmail refused the read for now", async () => {
    failure = "throttled";
    renderHook(() => usePassiveSenderStats(url(), "a"), { wrapper });
    await settle(0);
    await settle(10 * 60_000);

    expect(reads).toBe(1);
  });
});

function url() {
  return `/api/user/stats/newsletters?sender=${urlNumber}`;
}

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        fetcher: async () => {
          reads += 1;
          return {
            newsletters: [],
            filtersAvailable: failure === undefined,
            filtersFailure: failure,
          };
        },
      }}
    >
      {children}
    </SWRConfig>
  );
}

async function settle(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}
