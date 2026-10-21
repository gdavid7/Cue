/** @vitest-environment jsdom */

import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { SWRConfig, useSWRConfig } from "swr";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MailClient } from "@inboxzero/mail-core/engine";
import type { OperationState } from "@inboxzero/mail-core/operations";
import {
  refreshUpcomingScheduledEmails,
  useAllAccountsHiddenDraftMessageIds,
  useHiddenDraftMessageIds,
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

describe("drafts a send stands in for, across a reload", () => {
  beforeEach(() => {
    storage = new Map();
    vi.stubGlobal("sessionStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ scheduledEmails: [] })),
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a draft out of Drafts after a reload while its send is held or queued", async () => {
    const before = await loadPage();
    before.hideSendingDraftMessages("account-a", ["draft-a"], "send-a");

    const after = await loadPage();
    const { result } = renderHook(
      () => ({
        one: after.useHiddenDraftMessageIds("account-a"),
        all: after.useAllAccountsHiddenDraftMessageIds(ACCOUNTS),
      }),
      { wrapper },
    );

    expect(result.current.one).toEqual(["draft-a"]);
    expect(result.current.all).toEqual([
      { emailAccountId: "account-a", messageIds: ["draft-a"] },
    ]);
  });

  it("shows the draft again after a reload once its send is undone or fails", async () => {
    const before = await loadPage();
    before.hideSendingDraftMessages("account-a", ["draft-a"], "send-a");
    before.hideSendingDraftMessages("account-a", ["draft-b"], "send-b");

    const after = await loadPage();
    const stop = after.resumeSendingDrafts();
    const engine = createClient({ "send-a": "queued", "send-b": "queued" });
    after.setActiveMailClient(engine.client);
    const { result } = renderHook(
      () => after.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );
    expect(result.current).toEqual(["draft-a", "draft-b"]);

    act(() => engine.set("send-a", "cancelled"));
    expect(result.current).toEqual(["draft-b"]);
    act(() => engine.set("send-b", "failed"));
    expect(result.current).toEqual([]);

    // Gone for good: the next reload doesn't hide them either.
    stop();
    const later = await loadPage();
    const { result: reloaded } = renderHook(
      () => later.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );
    expect(reloaded.current).toEqual([]);
  });

  it("keeps every send's drafts hidden after a reload, however many copies a draft was saved as", async () => {
    const before = await loadPage();
    const saves = Array.from({ length: 60 }, (_, index) => `save-${index}`);
    before.hideSendingDraftMessages("account-a", saves, "send-a");
    before.hideSendingDraftMessages("account-a", ["draft-b"], "send-b");

    const after = await loadPage();
    const { result } = renderHook(
      () => after.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );

    expect(result.current).toEqual([...saves.slice(-50), "draft-b"]);
  });

  it("keeps the sends it can read when one stored send is unreadable", async () => {
    storage.set(
      "cue:sending-drafts",
      JSON.stringify([
        { emailAccountId: "account-a" },
        {
          emailAccountId: "account-a",
          operationId: "send-b",
          messageIds: ["draft-b"],
        },
      ]),
    );

    const after = await loadPage();
    const { result } = renderHook(
      () => after.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );

    expect(result.current).toEqual(["draft-b"]);
  });

  it("shows a draft again when its send may not have gone out, but not while it waits for a reconnect", async () => {
    const before = await loadPage();
    before.hideSendingDraftMessages("account-a", ["draft-a"], "send-a");
    before.hideSendingDraftMessages("account-a", ["draft-b"], "send-b");

    const after = await loadPage();
    const stop = after.resumeSendingDrafts();
    const engine = createClient({ "send-a": "queued", "send-b": "queued" });
    after.setActiveMailClient(engine.client);
    const { result } = renderHook(
      () => after.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );

    act(() => engine.set("send-a", "uncertain"));
    act(() => engine.set("send-b", "blocked_auth"));
    expect(result.current).toEqual(["draft-b"]);
    stop();
  });

  it("watches a send queued on this page too", async () => {
    const page = await loadPage();
    const stop = page.resumeSendingDrafts();
    const engine = createClient({ "send-a": "queued" });
    page.setActiveMailClient(engine.client);
    const { result } = renderHook(
      () => page.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );

    act(() => {
      page.hideSendingDraftMessages("account-a", ["draft-a"], "send-a");
    });
    expect(result.current).toEqual(["draft-a"]);
    act(() => engine.set("send-a", "failed"));
    expect(result.current).toEqual([]);
    stop();
  });

  it("keeps the draft hidden once its send has gone out", async () => {
    const before = await loadPage();
    before.hideSendingDraftMessages("account-a", ["draft-a"], "send-a");

    const after = await loadPage();
    const stop = after.resumeSendingDrafts();
    const engine = createClient({ "send-a": "queued" });
    after.setActiveMailClient(engine.client);
    act(() => engine.set("send-a", "succeeded"));
    stop();

    const later = await loadPage();
    const { result } = renderHook(
      () => later.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );
    expect(result.current).toEqual(["draft-a"]);
  });

  it("forgets a draft's send for the next user of the tab on sign-out", async () => {
    const before = await loadPage();
    before.hideSendingDraftMessages("account-a", ["draft-a"], "send-a");

    const after = await loadPage();
    const stop = after.resumeSendingDrafts();
    await after.closeActiveMailEngine();
    stop();

    const later = await loadPage();
    const { result } = renderHook(
      () => later.useHiddenDraftMessageIds("account-a"),
      { wrapper },
    );
    expect(result.current).toEqual([]);
  });
});

describe("drafts a scheduled send delivered", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("keeps a draft out of Drafts once the server has sent it, until sync drops it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const accountId =
          new Headers(init?.headers).get("X-Email-Account-ID") ?? "";
        return Response.json({
          scheduledEmails: [],
          sentDraftMessageIds: accountId === "account-a" ? ["draft-sent"] : [],
        });
      }),
    );

    const { result } = renderHook(
      () => ({
        one: useHiddenDraftMessageIds("account-a"),
        all: useAllAccountsHiddenDraftMessageIds(ACCOUNTS),
      }),
      { wrapper: wrapperWithFetcher },
    );

    await waitFor(() => {
      expect(result.current.one).toEqual(["draft-sent"]);
      expect(result.current.all).toEqual([
        { emailAccountId: "account-a", messageIds: ["draft-sent"] },
      ]);
    });
  });
});

let storage = new Map<string, string>();

// A fresh copy of the page's modules, as a reload leaves them; session
// storage is what carries over.
async function loadPage() {
  vi.resetModules();
  const hidden = await import("@/hooks/useHiddenDraftMessageIds");
  const active = await import("@/utils/mail-engine/active-client");
  return {
    ...hidden,
    setActiveMailClient: active.setActiveMailClient,
    closeActiveMailEngine: active.closeActiveMailEngine,
  };
}

function createClient(initial: Record<string, OperationState["status"]>) {
  const statuses = { ...initial };
  const listeners = new Map<string, Set<() => void>>();
  const client = {
    observeOperation: ({ operationId }: { operationId: string }) => ({
      getSnapshot: () => ({
        status: "ready",
        revision: null,
        data: {
          key: { accountId: "account-a", operationId },
          status: statuses[operationId] ?? "failed",
          authority: "backend",
          attempts: 0,
          nextAttemptAtMs: null,
          error: null,
        },
        refreshing: false,
        error: null,
      }),
      subscribe: (listener: () => void) => {
        const set = listeners.get(operationId) ?? new Set();
        set.add(listener);
        listeners.set(operationId, set);
        return () => set.delete(listener);
      },
      close: () => {},
    }),
  } as unknown as MailClient;
  return {
    client,
    set(operationId: string, status: OperationState["status"]) {
      statuses[operationId] = status;
      for (const listener of listeners.get(operationId) ?? []) listener();
    },
  };
}

function wrapper({ children }: { children: ReactNode }) {
  return (
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      {children}
    </SWRConfig>
  );
}

// The app's fetcher reads a key's account into the account header.
function wrapperWithFetcher({ children }: { children: ReactNode }) {
  return (
    <SWRConfig
      value={{
        provider: () => new Map(),
        dedupingInterval: 0,
        fetcher: ([url, emailAccountId]: [string, string]) =>
          fetch(url, {
            headers: { "X-Email-Account-ID": emailAccountId },
          }).then((response) => response.json()),
      }}
    >
      {children}
    </SWRConfig>
  );
}
