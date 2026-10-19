/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CUE_SEARCH_BUDGET_MS } from "@/app/(app)/[emailAccountId]/mail/cue-search";

const state = vi.hoisted(() => ({
  swrKeys: [] as (string | null)[],
  intent: undefined as unknown,
  /** Results by the joined searches each window runs. */
  results: new Map<string, { settled: boolean; ids: string[] }>(),
  enabledWindows: [] as string[],
}));

vi.mock("swr", () => ({
  default: (key: string | null) => {
    state.swrKeys.push(key);
    return { data: key ? state.intent : undefined, error: undefined };
  },
}));
vi.mock("@/utils/swr", () => ({ getAccountScopedKey: (key: string) => key }));
vi.mock("@/hooks/useLabels", () => ({ useLabels: () => ({ userLabels: [] }) }));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ provider: "google" }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads", () => ({
  useEngineMailThreads: ({
    predicate,
    enabled,
  }: {
    predicate?: unknown;
    enabled: boolean;
  }) => {
    const key = searchesOf(predicate).join(" | ");
    if (enabled) state.enabledWindows.push(key);
    const result = enabled ? state.results.get(key) : undefined;
    return {
      threads: (result?.ids ?? []).map((id) => ({ id, messages: [] })),
      hasRemoteResponse: Boolean(result?.settled),
      isLoading: false,
      providerSearchPending: !result?.settled,
    };
  },
}));

import { useCueSearch } from "@/app/(app)/[emailAccountId]/mail/use-cue-search";

const SENTENCE = "the lease contract Sarah sent last month";
const SEARCH =
  "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract";
const WIDER = "from:sarah (lease OR contract)";

function render(query: string | null, enabled = true) {
  return renderHook(
    ({ q }: { q: string | null }) =>
      useCueSearch({ emailAccountId: "account", query: q, enabled }),
    { initialProps: { q: query } },
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  state.swrKeys = [];
  state.intent = {
    searches: [SEARCH],
    explanation: "Mail from Sarah with attachments in September",
    isQuestion: false,
  };
  state.results = new Map();
  state.enabledWindows = [];
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useCueSearch", () => {
  it("asks nothing for a plain search, or without AI", () => {
    const plain = render("lease");
    expect(plain.result.current.stage).toBe("off");
    expect(plain.result.current.answerRequest).toEqual({ query: "lease" });

    const withoutAi = render(SENTENCE, false);
    expect(withoutAi.result.current.stage).toBe("off");
    expect(state.swrKeys.every((key) => key === null)).toBe(true);
  });

  it("shows what the searches found", () => {
    state.results.set(SEARCH, { settled: true, ids: ["a", "b", "c"] });
    const { result } = render(SENTENCE);

    expect(result.current.stage).toBe("done");
    expect(result.current.threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result.current.widerSearches).toEqual([]);
    expect(state.enabledWindows).not.toContain(WIDER);
  });

  it("widens once when the searches find too little, keeping what they found first", () => {
    state.results.set(SEARCH, { settled: true, ids: ["a"] });
    state.results.set(WIDER, { settled: true, ids: ["b", "a", "c"] });
    const { result, rerender } = render(SENTENCE);

    expect(result.current.widerSearches).toEqual([WIDER]);
    expect(result.current.stage).toBe("done");
    expect(result.current.threads.map((t) => t.id)).toEqual(["a", "b", "c"]);

    // The wider search finding nothing new doesn't widen again.
    state.results.set(WIDER, { settled: true, ids: [] });
    rerender({ q: SENTENCE });
    expect(result.current.widerSearches).toEqual([WIDER]);
    expect(new Set(state.enabledWindows)).toEqual(new Set([SEARCH, WIDER]));
  });

  it("stops waiting at the budget and doesn't widen after it", () => {
    state.results.set(SEARCH, { settled: false, ids: [] });
    const { result, rerender } = render(SENTENCE);
    expect(result.current.stage).toBe("searching");

    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    expect(result.current.stage).toBe("done");

    state.results.set(SEARCH, { settled: true, ids: [] });
    rerender({ q: SENTENCE });
    expect(result.current.widerSearches).toEqual([]);
  });

  it("keeps out mail its searches find after the budget", () => {
    state.results.set(SEARCH, { settled: false, ids: ["a"] });
    const { result, rerender } = render(SENTENCE);
    expect(result.current.threads.map((t) => t.id)).toEqual(["a"]);

    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    state.results.set(SEARCH, { settled: true, ids: ["late", "a"] });
    rerender({ q: SENTENCE });

    expect(result.current.threads.map((t) => t.id)).toEqual(["a"]);
    expect(result.current.foundNothing).toBe(false);
  });

  it("says it found nothing only once its searches have answered", () => {
    state.results.set(SEARCH, { settled: false, ids: [] });
    const { result, rerender } = render(SENTENCE);
    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    expect(result.current.stage).toBe("done");
    expect(result.current.foundNothing).toBe(false);

    state.results.set(SEARCH, { settled: true, ids: [] });
    rerender({ q: SENTENCE });
    expect(result.current.foundNothing).toBe(true);
  });

  it("starts the budget again for a search that comes back", () => {
    state.results.set(SEARCH, { settled: false, ids: [] });
    const { result, rerender } = render(SENTENCE);
    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    expect(result.current.stage).toBe("done");

    rerender({ q: "invoices from Acme this year" });
    rerender({ q: SENTENCE });
    expect(result.current.stage).toBe("searching");
  });

  it("drops a reading that arrives after the budget and answers from the typed words", () => {
    state.intent = undefined;
    const { result, rerender } = render("when is my flight?");
    expect(result.current.stage).toBe("reading");
    expect(result.current.answerRequest).toBeNull();

    act(() => {
      vi.advanceTimersByTime(CUE_SEARCH_BUDGET_MS);
    });
    state.intent = {
      searches: ["flight OR itinerary"],
      explanation: "Flight details",
      isQuestion: true,
    };
    rerender({ q: "when is my flight?" });

    expect(result.current.stage).toBe("off");
    expect(result.current.answerRequest).toEqual({
      query: "when is my flight?",
    });
  });

  it("answers a question from Cue's searches", () => {
    state.intent = {
      searches: ["flight OR itinerary"],
      explanation: "Flight details",
      isQuestion: true,
    };
    const { result } = render("when is my flight?");
    expect(result.current.answerRequest).toEqual({
      query: "when is my flight?",
      searches: ["flight OR itinerary"],
    });
  });
});

function searchesOf(predicate: unknown): string[] {
  if (!predicate || typeof predicate !== "object") return [];
  const node = predicate as {
    kind: string;
    query?: string;
    predicates?: unknown[];
  };
  if (node.kind === "search" && node.query) return [node.query];
  return (node.predicates ?? []).flatMap(searchesOf);
}
