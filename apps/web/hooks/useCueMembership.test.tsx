// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAIL_QUERY_FEATURES } from "@inboxzero/mail-core/capabilities";
import { PERSISTED_SWR_KEYS } from "@/utils/swr-persistence";
import { CUE_MEMBERSHIP_KEY, useCueMembership } from "./useCueMembership";

const engine = vi.hoisted(() => ({
  client: null as { capabilities?: readonly string[] } | null,
}));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => engine.client,
}));

afterEach(() => {
  cleanup();
  engine.client = null;
});

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
      byConversation: false,
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
      expect(result.current).toEqual({
        membership,
        unavailable: false,
        byConversation: false,
      }),
    );
  });

  it("names whole conversations only to an engine that can match them", async () => {
    const membership = {
      TO_REPLY: [],
      NEWSLETTER: ["m2"],
      MARKETING: [],
      threads: { TO_REPLY: [], NEWSLETTER: ["c1"], MARKETING: [] },
    };
    const load = vi.fn(async () => membership);

    // An engine bundled with an older desktop build reports nothing.
    engine.client = {};
    const older = renderHook(() => useCueMembership(true), {
      wrapper: wrapper(load),
    });
    await waitFor(() =>
      expect(older.result.current.membership).toEqual({
        TO_REPLY: [],
        NEWSLETTER: ["m2"],
        MARKETING: [],
      }),
    );
    expect(older.result.current.byConversation).toBe(false);
    older.unmount();

    engine.client = { capabilities: MAIL_QUERY_FEATURES };
    const current = renderHook(() => useCueMembership(true), {
      wrapper: wrapper(load),
    });
    await waitFor(() =>
      expect(current.result.current).toEqual({
        membership,
        unavailable: false,
        byConversation: true,
      }),
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
