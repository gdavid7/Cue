/** @vitest-environment jsdom */

import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CUE_ACCOUNT_SEARCH_TIMEOUT_MS,
  CUE_PROVIDER_SEARCH_CONCURRENCY,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes-cue-search";
import { CUE_SEARCH_BUDGET_MS } from "@/app/(app)/[emailAccountId]/mail/cue-search";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";

type Row = { id: string; subject: string };

const state = vi.hoisted(() => ({
  swrKeys: [] as unknown[],
  intent: undefined as unknown,
  /** Each account's local mail Cue's search finds. */
  rows: {} as Record<string, Row[]>,
  /** Accounts whose provider has answered. */
  answered: new Set<string>(),
  windows: [] as { accountIds: string[]; predicate?: MailPredicate }[],
}));

vi.mock("swr", () => ({
  default: (key: unknown) => {
    state.swrKeys.push(key);
    return { data: key ? state.intent : undefined, error: undefined };
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
    state.windows.push({ accountIds, predicate });
    const providerIds = providerSearchAccounts(predicate);
    return {
      threads: accountIds.flatMap((accountId) =>
        (state.rows[accountId] ?? []).map((row) => ({
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
      providerSearchAccounts: providerIds.map((accountId) => ({
        accountId,
        state: state.answered.has(accountId) ? "complete" : "searching",
        answered: state.answered.has(accountId),
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
  state.rows = {};
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

    const window = state.windows.at(-1);
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
    expect(CUE_PROVIDER_SEARCH_CONCURRENCY).toBe(2);
    expect(providerSearchAccounts(state.windows.at(-1)?.predicate)).toEqual([
      "work",
      "home",
    ]);

    state.answered = new Set(["work"]);
    rerender();
    rerender();
    expect(providerSearchAccounts(state.windows.at(-1)?.predicate)).toEqual([
      "work",
      "home",
      "side",
    ]);
  });

  it("shows what it found without waiting on a slow account, then stops waiting", () => {
    state.rows = { work: [{ id: "w1", subject: "Lease from Sarah" }] };
    state.answered = new Set(["work"]);
    const { result } = render([WORK, HOME]);
    expect(result.current.stage).toBe("searching");

    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    expect(result.current.stage).toBe("done");
    expect(result.current.threads.map((thread) => thread.id)).toEqual(["w1"]);
    expect(result.current.stillSearching.map((account) => account.id)).toEqual([
      "home",
    ]);

    act(() => {
      vi.advanceTimersByTime(CUE_ACCOUNT_SEARCH_TIMEOUT_MS);
    });
    // Its provider is no longer asked; its local mail still counts.
    expect(providerSearchAccounts(state.windows.at(-1)?.predicate)).toEqual([
      "work",
    ]);
    expect(result.current.stillSearching).toEqual([]);
    expect(result.current.foundNothing).toBe(false);
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
