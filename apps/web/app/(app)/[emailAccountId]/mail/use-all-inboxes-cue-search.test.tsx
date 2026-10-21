/** @vitest-environment jsdom */

import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
  CUE_PROVIDER_SEARCH_QUEUE,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import { CUE_SEARCH_BUDGET_MS } from "@/app/(app)/[emailAccountId]/mail/cue-search";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";

type Row = { id: string; subject: string };

const state = vi.hoisted(() => ({
  swrKeys: [] as unknown[],
  intent: undefined as unknown,
  /** Each account's local mail Cue's search finds. */
  rows: {} as Record<string, Row[]>,
  /** Each account's mail its widened search finds. */
  widerRows: {} as Record<string, Row[]>,
  /** Accounts whose last resort the provider has answered. */
  widerAnswered: new Set<string>(),
  /** The first searches' window holds more than one page. */
  hasMore: false,
  /** When the engine began each account's last resort. */
  widerStartedAt: {} as Record<string, number>,
  /** Accounts whose provider has answered. */
  answered: new Set<string>(),
  /** When the engine began each account's search; absent while queued. */
  startedAt: {} as Record<string, number>,
  routedLabels: [] as { name: string }[],
  fetcher: undefined as undefined | (() => unknown),
  fetchBodies: [] as unknown[],
  windows: [] as {
    accountIds: string[];
    predicate?: MailPredicate;
    /** A window of Cue's wider tiers, which drop the search's word. */
    widened: boolean;
  }[],
}));

vi.mock("swr", () => ({
  default: (key: unknown, fetcher: (key: unknown) => unknown) => {
    state.swrKeys.push(key);
    state.fetcher = () => fetcher(key);
    return { data: key ? state.intent : undefined, error: undefined };
  },
}));
vi.mock("@/hooks/useLabels", () => ({
  useLabels: () => ({ userLabels: state.routedLabels, isLoading: false }),
}));
vi.mock("@/providers/swr-fetcher", () => ({
  swrFetcher: (_path: string, init: { body: string }) => {
    state.fetchBodies.push(JSON.parse(init.body));
    return Promise.resolve(state.intent);
  },
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads", () => ({
  useEngineMailThreads: ({
    accountIds,
    accounts,
    predicate,
    enabled,
  }: {
    accountIds: string[];
    accounts: Record<string, { id: string; email: string }>;
    predicate?: MailPredicate;
    enabled: boolean;
  }) => {
    if (!enabled)
      return {
        threads: [],
        hasRemoteResponse: false,
        isLoading: false,
        providerSearchAccounts: [],
      };
    const widened = !JSON.stringify(predicate).includes("lease");
    state.windows.push({ accountIds, predicate, widened });
    const providerIds = providerSearchAccounts(predicate);
    const rows = widened ? state.widerRows : state.rows;
    const answered = widened ? state.widerAnswered : state.answered;
    const startedAt = widened ? state.widerStartedAt : state.startedAt;
    return {
      threads: accountIds.flatMap((accountId) =>
        (rows[accountId] ?? []).map((row) => ({
          id: row.id,
          account: accounts[accountId],
          messages: [
            {
              id: `${row.id}-message`,
              internalDate: "0",
              subject: row.subject,
              headers: { subject: row.subject },
            },
          ],
        })),
      ),
      hasRemoteResponse: true,
      isLoading: false,
      hasMore: !widened && state.hasMore,
      providerSearchAccounts: providerIds.map((accountId) => ({
        accountId,
        state: answered.has(accountId) ? "complete" : "searching",
        answered: answered.has(accountId),
        ...(answered.has(accountId) || startedAt[accountId] === undefined
          ? {}
          : { startedAtMs: startedAt[accountId] }),
      })),
    };
  },
}));

import { useAllInboxesCueSearch } from "@/app/(app)/[emailAccountId]/mail/use-all-inboxes-cue-search";

const SENTENCE = "the lease Sarah sent";
const WORK: AllInboxesAccount = {
  id: "work",
  email: "me@work.example",
  name: null,
  image: null,
  provider: "google",
};
const HOME: AllInboxesAccount = {
  id: "home",
  email: "me@home.example",
  name: null,
  image: null,
  provider: "microsoft",
};
const SIDE: AllInboxesAccount = {
  id: "side",
  email: "me@side.example",
  name: null,
  image: null,
  provider: "google",
};

function render(accounts: AllInboxesAccount[]) {
  return renderHook(() =>
    useAllInboxesCueSearch({
      emailAccountId: "work",
      accounts,
      labelsByAccount: {},
      query: SENTENCE,
      enabled: true,
    }),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  state.swrKeys = [];
  state.windows = [];
  state.answered = new Set();
  state.startedAt = {};
  state.routedLabels = [];
  state.fetchBodies = [];
  state.rows = {};
  state.widerRows = {};
  state.widerAnswered = new Set();
  state.widerStartedAt = {};
  state.hasMore = false;
  state.intent = {
    searches: ["from:sarah lease"],
    editableSearches: ["from:sarah lease"],
    unreadOnly: false,
    explanation: "Lease from Sarah",
    isQuestion: false,
    timeZone: "UTC",
    parts: {
      senders: ["sarah"],
      recipients: [],
      sentByUser: false,
      keywordGroups: [["lease"]],
      hasAttachment: false,
      unread: false,
      starred: false,
      label: "",
      dateRange: "none",
      lastNDays: 0,
      fromDate: "",
      toDate: "",
      explanation: "Lease from Sarah",
      isQuestion: false,
    },
  };
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useAllInboxesCueSearch", () => {
  it("reads the search once and searches each included account in its own syntax", () => {
    render([WORK, HOME]);

    const intentKeys = state.swrKeys.filter(Boolean).map(String);
    expect(new Set(intentKeys).size).toBe(1);
    expect(intentKeys[0]).toContain("work");

    const window = primaryWindow();
    expect(window?.accountIds).toEqual(["work", "home"]);
    expect(searchesOf(window?.predicate)).toEqual([
      { accountIds: ["work"], query: "from:sarah lease" },
      { accountIds: ["home"], query: "from:sarah lease" },
    ]);
  });

  it("never searches an account left out of All inboxes", () => {
    state.rows = { work: [{ id: "w1", subject: "Lease" }] };
    render([WORK]);

    for (const window of state.windows) {
      expect(window.accountIds).not.toContain("side");
      expect(JSON.stringify(window.predicate)).not.toContain("side");
    }
  });

  it("ranks every account's matches together, each row keeping its account", () => {
    state.rows = {
      work: [{ id: "w1", subject: "Weekly update" }],
      home: [{ id: "h1", subject: "Lease from Sarah" }],
    };
    state.answered = new Set(["work", "home"]);
    const { result } = render([WORK, HOME]);

    // The row that fits the search best leads, whichever account it's in.
    expect(
      result.current.threads.map((thread) => [
        "account" in thread ? thread.account.id : null,
        thread.id,
      ]),
    ).toEqual([
      ["home", "h1"],
      ["work", "w1"],
    ]);
    expect(result.current.stage).toBe("done");
    expect(result.current.stillSearching).toEqual([]);
  });

  it("asks a few providers at a time, and the next once one answers", () => {
    const { rerender } = render([WORK, HOME, SIDE]);
    expect(CUE_PROVIDER_SEARCH_QUEUE).toBe(2);
    expect(providerSearchAccounts(primaryWindow()?.predicate)).toEqual([
      "work",
      "home",
    ]);

    state.answered = new Set(["work"]);
    rerender();
    rerender();
    expect(providerSearchAccounts(primaryWindow()?.predicate)).toEqual([
      "work",
      "home",
      "side",
    ]);
  });

  it("shows what it found without waiting on a slow account, then stops it", () => {
    state.rows = {
      work: [
        { id: "w1", subject: "Lease from Sarah" },
        { id: "w2", subject: "Lease from Sarah" },
      ],
    };
    state.answered = new Set(["work"]);
    const { result, rerender } = render([WORK, HOME]);
    expect(result.current.stage).toBe("searching");

    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    expect(result.current.stage).toBe("done");
    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "w1",
      "w2",
    ]);
    expect(result.current.stillSearching.map((account) => account.id)).toEqual([
      "home",
    ]);

    // Its wait in the engine's queue doesn't count against it...
    act(() => {
      vi.advanceTimersByTime(CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
    });
    expect(providerSearchAccounts(primaryWindow()?.predicate)).toEqual([
      "work",
      "home",
    ]);

    // ...only the time from when the engine began it.
    state.startedAt = { home: Date.now() };
    rerender();
    act(() => {
      vi.advanceTimersByTime(CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
    });
    // Its provider is no longer asked; its local mail still counts.
    expect(providerSearchAccounts(primaryWindow()?.predicate)).toEqual([
      "work",
    ]);
    expect(result.current.stillSearching).toEqual([]);
    expect(result.current.timedOut.map((account) => account.id)).toEqual([
      "home",
    ]);
    expect(result.current.foundNothing).toBe(false);
  });

  it("stops waiting on an account whose start never arrives", () => {
    state.answered = new Set(["work"]);
    const { result } = render([WORK, HOME]);

    act(() => {
      vi.advanceTimersByTime(2 * CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
    });
    expect(providerSearchAccounts(primaryWindow()?.predicate)).toEqual([
      "work",
    ]);
    expect(result.current.timedOut.map((account) => account.id)).toEqual([
      "home",
    ]);
  });

  it("asks with the routed account's labels and shows each account's searches", async () => {
    state.routedLabels = [{ name: "Receipts" }];
    const parts = (state.intent as { parts: Record<string, unknown> }).parts;
    state.intent = {
      ...(state.intent as object),
      parts: { ...parts, hasAttachment: true },
    };
    const { result } = renderHook(() =>
      useAllInboxesCueSearch({
        emailAccountId: "work",
        accounts: [WORK, HOME],
        labelsByAccount: {
          home: { L1: { id: "L1", name: "Family", type: "user" } },
        } as never,
        query: SENTENCE,
        enabled: true,
      }),
    );

    // The routed account's labels alone, as its own search sends.
    await state.fetcher?.();
    expect(state.fetchBodies).toEqual([{ q: SENTENCE, labels: ["Receipts"] }]);
    expect(result.current.intent?.searches).toEqual([
      "from:sarah lease has:attachment",
      "from:sarah lease hasattachments:true",
    ]);
    expect(result.current.answerRequest).toBeNull();
  });

  it("keeps each account's search once read, though its labels load later", () => {
    const parts = (state.intent as { parts: Record<string, unknown> }).parts;
    state.intent = {
      ...(state.intent as object),
      parts: { ...parts, label: "Receipts" },
    };
    let labelsByAccount = {};
    const { rerender } = renderHook(() =>
      useAllInboxesCueSearch({
        emailAccountId: "work",
        accounts: [WORK],
        labelsByAccount,
        query: SENTENCE,
        enabled: true,
      }),
    );
    const before = searchesOf(primaryWindow()?.predicate);

    labelsByAccount = {
      work: { L1: { id: "L1", name: "Receipts", type: "user" } },
    };
    rerender();
    rerender();

    expect(searchesOf(primaryWindow()?.predicate)).toEqual(before);
  });

  it("puts mail a slow account finds late below the rows already shown", () => {
    state.rows = { work: [{ id: "w1", subject: "Weekly update" }] };
    state.answered = new Set(["work"]);
    const { result, rerender } = render([WORK, HOME]);
    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });

    state.rows = {
      ...state.rows,
      home: [{ id: "h1", subject: "Lease Sarah" }],
    };
    state.answered = new Set(["work", "home"]);
    rerender();
    rerender();

    expect(result.current.threads.map((thread) => thread.id)).toEqual([
      "w1",
      "h1",
    ]);
    expect(result.current.stillSearching).toEqual([]);
  });
});

describe("useAllInboxesCueSearch widening", () => {
  it("widens only the account whose search found too little, its mail below", () => {
    state.rows = {
      work: [
        { id: "w1", subject: "Lease from Sarah" },
        { id: "w2", subject: "Lease from Sarah" },
      ],
    };
    state.answered = new Set(["work", "home"]);
    state.widerRows = { home: [{ id: "h1", subject: "Hello from Sarah" }] };
    const { result, rerender } = render([WORK, HOME]);
    rerender();

    const wider = widenedWindows();
    expect(wider.length).toBeGreaterThan(0);
    for (const window of wider) expect(window.accountIds).toEqual(["home"]);
    // A tier reads the local mail alone: no provider search.
    expect(providerSearchAccounts(wider.at(-1)?.predicate)).toEqual([]);
    expect(result.current.widening).toMatchObject({
      tier: "fewer_words",
      onProvider: false,
    });
    expect(
      result.current.threads.map((thread) => [
        "account" in thread ? thread.account.id : null,
        thread.id,
      ]),
    ).toEqual([
      ["work", "w1"],
      ["work", "w2"],
      ["home", "h1"],
    ]);
    expect(result.current.stage).toBe("done");
  });

  it("doesn't widen an account a busier one may have pushed off a full page", () => {
    state.rows = {
      work: [
        { id: "w1", subject: "Lease from Sarah" },
        { id: "w2", subject: "Lease from Sarah" },
      ],
    };
    state.answered = new Set(["work", "home"]);
    state.hasMore = true;
    const { result, rerender } = render([WORK, HOME]);
    rerender();

    expect(widenedWindows()).toEqual([]);
    expect(result.current.widening).toBeNull();

    // Once the page holds everything, "home" really found nothing.
    state.hasMore = false;
    rerender();
    rerender();
    expect(widenedWindows().at(-1)?.accountIds).toEqual(["home"]);
  });

  it("doesn't widen while an account's search is still running", () => {
    state.answered = new Set(["work"]);
    state.rows = {
      work: [
        { id: "w1", subject: "Lease from Sarah" },
        { id: "w2", subject: "Lease from Sarah" },
      ],
    };
    const { result, rerender } = render([WORK, HOME]);
    rerender();

    expect(widenedWindows()).toEqual([]);
    expect(result.current.widening).toBeNull();
    expect(result.current.stage).toBe("searching");
  });

  it("sends a last resort through the same queue and time box", () => {
    // Nothing turns up anywhere, so every account climbs to its last
    // resort, while "side" still holds a turn with its first search.
    state.answered = new Set(["work", "home"]);
    const { result, rerender } = render([WORK, HOME, SIDE]);
    for (let i = 0; i < 4; i++) rerender();

    expect(providerSearchAccounts(primaryWindow()?.predicate)).toEqual([
      "work",
      "home",
      "side",
    ]);
    // One turn is free beside "side", and "work" is first in line.
    expect(providerSearchAccounts(widenedWindows().at(-1)?.predicate)).toEqual([
      "work",
    ]);
    expect(result.current.widening?.onProvider).toBe(true);
    expect(result.current.stillSearching).toEqual([]);

    // The last resort is timed from its start like any provider search.
    state.widerStartedAt = { work: Date.now() };
    rerender();
    act(() => {
      vi.advanceTimersByTime(CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
    });
    rerender();
    expect(
      providerSearchAccounts(widenedWindows().at(-1)?.predicate),
    ).not.toContain("work");
    // "home" was still waiting when the budget ran out, so it's never sent:
    // what it found would land after the rows were read.
    expect(providerSearchAccounts(widenedWindows().at(-1)?.predicate)).toEqual(
      [],
    );
    // Only "side"'s first search is still out, and only it shows as pending.
    expect(result.current.stillSearching.map((account) => account.id)).toEqual([
      "side",
    ]);
  });

  it("never widens into an account left out of All inboxes", () => {
    state.answered = new Set(["work"]);
    const { rerender } = render([WORK]);
    for (let i = 0; i < 3; i++) rerender();

    expect(widenedWindows().length).toBeGreaterThan(0);
    for (const window of state.windows) {
      expect(window.accountIds).toEqual(["work"]);
      expect(JSON.stringify(window.predicate)).not.toMatch(/home|side/);
    }
  });
});

function primaryWindow() {
  return state.windows.filter((window) => !window.widened).at(-1);
}

function widenedWindows() {
  return state.windows.filter((window) => window.widened);
}

function searchesOf(predicate: MailPredicate | undefined) {
  const found: { accountIds?: string[]; query: string }[] = [];
  visit(predicate, (node) => {
    if (node.kind === "search")
      found.push({ accountIds: node.accountIds, query: node.query });
  });
  return found;
}

function providerSearchAccounts(predicate: MailPredicate | undefined) {
  return searchesOf(predicate).flatMap((search) => search.accountIds ?? []);
}

function visit(
  predicate: MailPredicate | undefined,
  callback: (node: MailPredicate) => void,
) {
  if (!predicate) return;
  callback(predicate);
  if (predicate.kind === "all" || predicate.kind === "any")
    for (const child of predicate.predicates) visit(child, callback);
  if (predicate.kind === "not") visit(predicate.predicate, callback);
}
