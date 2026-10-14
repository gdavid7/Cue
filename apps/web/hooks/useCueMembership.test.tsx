// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PERSISTED_SWR_KEYS } from "@/utils/swr-persistence";
import { CUE_MEMBERSHIP_KEY, useCueMembership } from "./useCueMembership";

afterEach(cleanup);

describe("useCueMembership", () => {
  it("falls back to empty membership when it can't load, rather than waiting forever", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("offline");
    });

    const { result } = renderHook(() => useCueMembership(true), {
      wrapper: wrapper(fetcher),
    });

    expect(result.current).toEqual({
      membership: undefined,
      unavailable: false,
    });
    await waitFor(() => expect(result.current.unavailable).toBe(true));
    expect(result.current.membership).toEqual({
      TO_REPLY: [],
      NEWSLETTER: [],
      MARKETING: [],
    });
  });

  it("returns what loaded", async () => {
    const membership = { TO_REPLY: ["m1"], NEWSLETTER: [], MARKETING: [] };
    const { result } = renderHook(() => useCueMembership(true), {
      wrapper: wrapper(vi.fn(async () => membership)),
    });

    await waitFor(() =>
      expect(result.current).toEqual({ membership, unavailable: false }),
    );
  });

  it("is kept for offline use like the other mail settings", () => {
    expect(PERSISTED_SWR_KEYS).toContain(CUE_MEMBERSHIP_KEY);
  });
});

function wrapper(fetcher: () => Promise<unknown>) {
  return ({ children }: { children: ReactNode }) => (
    <SWRConfig
      value={{
        provider: () => new Map(),
        fetcher,
        shouldRetryOnError: false,
      }}
    >
      {children}
    </SWRConfig>
  );
}
