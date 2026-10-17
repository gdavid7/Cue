// @vitest-environment jsdom

import { createElement, type ReactNode } from "react";
import { renderHook, waitFor } from "@testing-library/react";
import { SWRConfig } from "swr";
import { describe, expect, it, vi } from "vitest";
import { getInboxInsightRequests, useInboxInsights } from "./useInboxInsights";

vi.mock("@/providers/EmailAccountProvider", () => ({ useAccount: vi.fn() }));

describe("getInboxInsightRequests", () => {
  it("asks each account about its own rows, even when thread ids collide", () => {
    const requests = getInboxInsightRequests([
      item({ emailAccountId: "work", threadId: "t1" }),
      item({ emailAccountId: "personal", threadId: "t1" }),
      item({ emailAccountId: "work", threadId: "t2" }),
    ]);

    expect(
      requests.map((request) => ({
        emailAccountId: request.emailAccountId,
        keys: request.items.map((requestItem) => requestItem.key),
      })),
    ).toEqual([
      { emailAccountId: "personal", keys: ["personal:t1"] },
      { emailAccountId: "work", keys: ["work:t1", "work:t2"] },
    ]);
  });

  it("drops repeated rows and splits an account's rows into pages of 50", () => {
    const items = Array.from({ length: 51 }, (_, index) =>
      item({ emailAccountId: "work", threadId: `t${index}` }),
    );
    const requests = getInboxInsightRequests([...items, items[0]]);

    expect(requests.map((request) => request.items.length)).toEqual([50, 1]);
  });
});

describe("useInboxInsights", () => {
  it("asks for nothing while paused, then asks once for the rows on screen", async () => {
    const fetcher = vi.fn(async () => ({
      insights: { t1: { insight: null, meeting: null, reply: "ready" } },
    }));
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        { value: { fetcher, provider: () => new Map() } },
        children,
      );
    const items = [item({ emailAccountId: "work", threadId: "t1" })];

    const { result, rerender } = renderHook(
      ({ enabled }) => useInboxInsights(items, { enabled }),
      { wrapper, initialProps: { enabled: false } },
    );
    rerender({ enabled: false });
    expect(fetcher).not.toHaveBeenCalled();

    rerender({ enabled: true });
    await waitFor(() =>
      expect(result.current.data).toEqual({
        "work:t1": { insight: null, meeting: null, reply: "ready" },
      }),
    );
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the insights already shown when a new page is rate limited", async () => {
    const fetcher = vi.fn(async ([url]: [string, string]) => {
      if (url.includes("t2")) {
        throw Object.assign(new Error("Rate limited"), { status: 429 });
      }
      return {
        insights: { t1: { insight: null, meeting: null, reply: "ready" } },
      };
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        {
          value: {
            fetcher,
            provider: () => new Map(),
            shouldRetryOnError: false,
          },
        },
        children,
      );

    const { result, rerender } = renderHook(
      ({ items }) => useInboxInsights(items),
      {
        wrapper,
        initialProps: {
          items: [item({ emailAccountId: "work", threadId: "t1" })],
        },
      },
    );
    await waitFor(() => expect(result.current.data).toBeDefined());
    const shown = result.current.data;

    rerender({
      items: [
        item({ emailAccountId: "work", threadId: "t1" }),
        item({ emailAccountId: "work", threadId: "t2" }),
      ],
    });
    await waitFor(() => expect(result.current.error).toBeDefined());

    expect(result.current.error).toMatchObject({ status: 429 });
    expect(result.current.data).toEqual(shown);
  });

  it("keeps the other accounts' insights when one account is busy, then fills it in", async () => {
    let personalBusy = true;
    const fetcher = vi.fn(async ([, emailAccountId]: [string, string]) => {
      if (emailAccountId === "personal" && personalBusy) {
        personalBusy = false;
        throw Object.assign(new Error("Gmail is busy"), {
          status: 503,
          retryAfterMs: 300,
        });
      }
      return {
        insights: { t1: { insight: null, meeting: null, reply: "ready" } },
      };
    });
    const wrapper = ({ children }: { children: ReactNode }) =>
      createElement(
        SWRConfig,
        {
          value: {
            fetcher,
            provider: () => new Map(),
            shouldRetryOnError: false,
          },
        },
        children,
      );
    const items = [
      item({ emailAccountId: "work", threadId: "t1" }),
      item({ emailAccountId: "personal", threadId: "t1" }),
    ];

    const { result } = renderHook(() => useInboxInsights(items), { wrapper });

    await waitFor(() =>
      expect(result.current.data).toEqual({
        "work:t1": { insight: null, meeting: null, reply: "ready" },
      }),
    );
    expect(result.current.error).toBeUndefined();

    await waitFor(() =>
      expect(result.current.data).toEqual({
        "work:t1": { insight: null, meeting: null, reply: "ready" },
        "personal:t1": { insight: null, meeting: null, reply: "ready" },
      }),
    );
  });
});

function item({
  emailAccountId,
  threadId,
}: {
  emailAccountId: string;
  threadId: string;
}) {
  return {
    key: `${emailAccountId}:${threadId}`,
    emailAccountId,
    threadId,
    messageId: `${threadId}-latest`,
  };
}
