/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  refreshUpcomingScheduledEmails,
  useAllAccountsHiddenDraftMessageIds,
} from "@/hooks/useHiddenDraftMessageIds";

const ACCOUNTS = [{ id: "account-a" }, { id: "account-b" }];

describe("useAllAccountsHiddenDraftMessageIds", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("hides a draft once a send is scheduled for it in one account and its sends are refreshed", async () => {
    const scheduledByAccount: Record<string, string[]> = {};
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const accountId =
        new Headers(init?.headers).get("X-Email-Account-ID") ?? "";
      return Response.json({
        scheduledEmails: (scheduledByAccount[accountId] ?? []).map(
          (draftMessageId) => ({
            id: `send-${draftMessageId}`,
            status: "PENDING",
            sendAt: new Date(Date.now() + 60 * 60_000).toISOString(),
            draftMessageIds: [draftMessageId],
          }),
        ),
      });
    });
    vi.stubGlobal("fetch", fetch);

    const { result } = renderHook(
      () => ({
        hidden: useAllAccountsHiddenDraftMessageIds(ACCOUNTS),
        mutate: useSWRConfig().mutate,
      }),
      { wrapper },
    );
    await waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(result.current.hidden).toEqual([]);

    // Account B's draft is scheduled, as from the composer, which refreshes
    // that account's sends wherever they are read.
    scheduledByAccount["account-b"] = ["draft-b"];
    await act(() =>
      refreshUpcomingScheduledEmails(result.current.mutate, "account-b"),
    );

    await waitFor(() =>
      expect(result.current.hidden).toEqual([
        { emailAccountId: "account-b", messageIds: ["draft-b"] },
      ]),
    );
  });
});

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}
