/** @vitest-environment jsdom */

import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TZDate } from "@date-fns/tz";
import {
  CUE_SEARCH_BUDGET_MS,
  getWideningLadder,
} from "@/app/(app)/[emailAccountId]/mail/cue-search";

const state = vi.hoisted(() => ({
  swrKeys: [] as unknown[],
  fetcher: undefined as undefined | ((key: unknown) => Promise<unknown>),
  labels: [] as { name: string }[],
  labelsLoading: false,
  intent: undefined as unknown,
  /** Results by the joined searches each window runs. */
  results: new Map<string, { settled: boolean; ids: string[] }>(),
  /** What the provider answers for a window, where it differs from local mail. */
  providerResults: new Map<string, { settled: boolean; ids: string[] }>(),
  enabledWindows: [] as string[],
  localOnlyWindows: [] as string[],
  enabledPredicates: [] as unknown[],
  provider: "google",
  client: null as null | { searchSemantic?: () => Promise<unknown> },
  semantic: undefined as unknown,
}));

vi.mock("swr", () => ({
  default: (key: unknown, fetcher: (key: unknown) => Promise<unknown>) => {
    if (Array.isArray(key) && key[0] === "cue-semantic")
      return { data: state.semantic, error: undefined };
    state.swrKeys.push(key);
    state.fetcher = fetcher;
    return { data: key ? state.intent : undefined, error: undefined };
  },
}));
vi.mock("@inboxzero/mail-react/MailEngineProvider", () => ({
  useOptionalMailClient: () => state.client,
}));
vi.mock("@/hooks/useLabels", () => ({
  useLabels: () => ({
    userLabels: state.labels,
    isLoading: state.labelsLoading,
  }),
}));
vi.mock("@/providers/EmailAccountProvider", () => ({
  useAccount: () => ({ provider: state.provider }),
}));
vi.mock("@/app/(app)/[emailAccountId]/mail/use-engine-mail-threads", () => ({
  useEngineMailThreads: ({
    predicate,
    providerSearch,
    enabled,
  }: {
    predicate?: unknown;
    providerSearch?: boolean;
    enabled: boolean;
  }) => {
    const key = searchesOf(predicate).join(" | ");
    if (enabled) state.enabledWindows.push(key);
    if (enabled && providerSearch === false) state.localOnlyWindows.push(key);
    if (enabled) state.enabledPredicates.push(predicate);
    const result = !enabled
      ? undefined
      : providerSearch !== false && state.providerResults.has(key)
        ? state.providerResults.get(key)
        : state.results.get(key);
    return {
      threads: (result?.ids ?? []).map((id) => ({ id, messages: [] })),
      hasRemoteResponse: Boolean(result?.settled),
      isLoading: false,
      providerSearchPending: !result?.settled,
    };
  },
}));

import {
  searchByMeaning,
  useCueSearch,
} from "@/app/(app)/[emailAccountId]/mail/use-cue-search";

const SENTENCE = "the lease contract Sarah sent last month";
const SEARCH =
  "from:sarah has:attachment after:2026/09/01 before:2026/10/01 lease OR contract";

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
  state.providerResults = new Map();
  state.enabledWindows = [];
  state.localOnlyWindows = [];
  state.enabledPredicates = [];
  state.provider = "google";
  state.labels = [];
  state.labelsLoading = false;
  state.client = null;
  state.semantic = undefined;
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

  it("sends the account's labels with the search, not in its address", async () => {
    state.labels = [{ name: "Receipts" }, { name: "Trips 2026" }];
    const fetchMock = vi.fn(async () => Response.json({ searches: [] }));
    vi.stubGlobal("fetch", fetchMock);
    render(SENTENCE);

    await state.fetcher?.(state.swrKeys.at(-1));

    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).not.toContain("Receipts");
    expect(url).not.toContain("lease");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({
      q: SENTENCE,
      labels: ["Receipts", "Trips 2026"],
    });
    vi.unstubAllGlobals();
  });

  it("waits for the account's labels before reading the search", () => {
    state.labelsLoading = true;
    const { rerender } = render(SENTENCE);
    expect(state.swrKeys.every((key) => key === null)).toBe(true);

    state.labelsLoading = false;
    rerender({ q: SENTENCE });
    expect(state.swrKeys.at(-1)).not.toBeNull();
  });

  it("shows what the searches found", () => {
    state.results.set(SEARCH, { settled: true, ids: ["a", "b", "c"] });
    const { result } = render(SENTENCE);

    expect(result.current.stage).toBe("done");
    expect(result.current.threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(result.current.widening).toBeNull();
    expect(new Set(state.enabledWindows)).toEqual(new Set([SEARCH]));
  });

  it("adds mail close in meaning, read from the local mail alone, and waits for it", () => {
    // Words alone: mail found by meaning must meet a search's sender and dates.
    const words = "lease OR contract";
    state.intent = { searches: [words], explanation: "", isQuestion: false };
    state.client = { searchSemantic: vi.fn() };
    state.results.set(words, { settled: true, ids: ["a", "b"] });
    state.results.set("messages:m-lease", { settled: true, ids: ["lease"] });
    const { result, rerender } = render(SENTENCE);
    expect(result.current.threads.map((t) => t.id)).toEqual(["a", "b"]);
    expect(result.current.foundNothing).toBe(false);

    state.semantic = [
      { messageId: "m-lease", conversationId: "lease", similarity: 0.8 },
    ];
    rerender({ q: SENTENCE });
    expect(result.current.threads.map((t) => t.id)).toContain("lease");
    expect(state.localOnlyWindows).toContain("messages:m-lease");
  });

  it("says it found nothing only once the search by meaning has answered too", () => {
    state.client = { searchSemantic: vi.fn() };
    state.results.set(SEARCH, { settled: true, ids: [] });
    for (const key of ladderKeys())
      state.results.set(key, { settled: true, ids: [] });
    const { result, rerender } = render(SENTENCE);
    expect(result.current.foundNothing).toBe(false);

    state.semantic = [];
    rerender({ q: SENTENCE });
    expect(result.current.foundNothing).toBe(true);
  });

  it("climbs the ladder past tiers that find nothing new, stopping at the first that does", () => {
    const [fewer, sender, dates] = ladderKeys();
    state.results.set(SEARCH, { settled: true, ids: ["a"] });
    state.results.set(fewer, { settled: true, ids: ["a"] });
    state.results.set(sender, { settled: true, ids: ["b", "a", "c"] });
    state.results.set(dates, { settled: true, ids: ["d"] });
    const { result } = render(SENTENCE);

    expect(result.current.widening?.tier).toBe("sender_and_dates");
    expect(result.current.stage).toBe("done");
    // What the first search found leads; the tier adds only what's new.
    expect(result.current.threads.map((t) => t.id)).toEqual(["a", "b", "c"]);
    expect(state.enabledWindows).not.toContain(dates);
    // Every tier reads the local mail alone.
    expect(state.localOnlyWindows).toEqual(
      expect.arrayContaining([fewer, sender]),
    );
    expect(state.localOnlyWindows).not.toContain(SEARCH);
  });

  it("waits on a tier before climbing past it", () => {
    const [fewer, sender] = ladderKeys();
    state.results.set(SEARCH, { settled: true, ids: [] });
    state.results.set(fewer, { settled: false, ids: [] });
    const { result } = render(SENTENCE);

    expect(result.current.stage).toBe("widening");
    expect(result.current.widening?.tier).toBe("fewer_words");
    expect(state.enabledWindows).not.toContain(sender);
  });

  it("sends the last tier to the provider once when no local search finds any mail", () => {
    const keys = ladderKeys();
    for (const key of keys) {
      state.results.set(key, { settled: true, ids: [] });
    }
    const last = keys[keys.length - 1];
    state.providerResults.set(last, { settled: false, ids: [] });
    state.results.set(SEARCH, { settled: true, ids: [] });
    const { result, rerender } = render(SENTENCE);

    expect(result.current.widening).toMatchObject({
      tier: "wider_dates",
      onProvider: true,
    });
    expect(result.current.stage).toBe("widening");
    expect(result.current.foundNothing).toBe(false);

    state.providerResults.set(last, { settled: true, ids: ["old"] });
    rerender({ q: SENTENCE });
    expect(result.current.stage).toBe("done");
    expect(result.current.threads.map((t) => t.id)).toEqual(["old"]);
  });

  it("sends only the first of a multi-search last tier to the provider", () => {
    const other =
      "from:bob has:attachment after:2026/09/01 before:2026/10/01 invoice OR receipt";
    state.intent = { searches: [SEARCH, other], isQuestion: false };
    const ladder = getWideningLadder([SEARCH, other], {
      now: new Date(),
      provider: "google",
    });
    const last = ladder[ladder.length - 1];
    expect(last.searches.length).toBeGreaterThan(1);
    state.results.set([SEARCH, other].join(" | "), { settled: true, ids: [] });
    for (const step of ladder) {
      state.results.set(step.searches.join(" | "), { settled: true, ids: [] });
    }
    state.results.set(last.searches[0], { settled: true, ids: [] });
    const { result } = render(SENTENCE);

    expect(result.current.widening).toMatchObject({
      tier: last.tier,
      onProvider: true,
    });
    const lastResort = state.enabledPredicates.at(-1) as {
      kind: string;
      predicates: unknown[];
    };
    // One provider search; the tier's other searches still read local mail.
    expect(searchesOf(lastResort)).toEqual([last.searches[0]]);
    expect(lastResort.kind).toBe("any");
    expect(lastResort.predicates).toHaveLength(last.searches.length);
    expect(state.localOnlyWindows).not.toContain(last.searches[0]);
  });

  it("says it found nothing once the provider's last-resort search finds nothing too", () => {
    for (const key of ladderKeys()) {
      state.results.set(key, { settled: true, ids: [] });
    }
    state.results.set(SEARCH, { settled: true, ids: [] });
    const { result } = render(SENTENCE);

    expect(result.current.widening?.onProvider).toBe(true);
    expect(result.current.stage).toBe("done");
    expect(result.current.foundNothing).toBe(true);
  });

  it("keeps the ladder local when the first search found some mail", () => {
    const keys = ladderKeys();
    for (const key of keys) {
      state.results.set(key, { settled: true, ids: ["a"] });
    }
    state.results.set(SEARCH, { settled: true, ids: ["a"] });
    const { result } = render(SENTENCE);

    expect(result.current.widening).toMatchObject({
      tier: "wider_dates",
      onProvider: false,
    });
    expect(result.current.threads.map((t) => t.id)).toEqual(["a"]);
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
    expect(result.current.widening).toBeNull();
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

  it("keeps only unread mail itself when the provider's search can't", () => {
    state.intent = {
      searches: ["from:sarah"],
      editableSearches: ["from:sarah"],
      unreadOnly: true,
      explanation: "Unread mail from Sarah",
      isQuestion: false,
    };
    state.results.set("from:sarah", { settled: true, ids: ["a", "b"] });
    render(SENTENCE);

    expect(JSON.stringify(state.enabledPredicates.at(-1))).toContain(
      '{"kind":"read","value":false}',
    );
  });

  it("reads an Outlook received day in the account's time zone", () => {
    state.intent = {
      searches: ["from:sarah received>=2026-10-03"],
      editableSearches: ["from:sarah received>=2026-10-03"],
      unreadOnly: false,
      explanation: "Mail from Sarah since October 3",
      isQuestion: false,
      timeZone: "Pacific/Auckland",
    };
    state.provider = "microsoft";
    render(SENTENCE);

    const received = findPredicate(state.enabledPredicates.at(-1), "received");
    expect(received).toMatchObject({
      afterMs: new TZDate(2026, 9, 3, "Pacific/Auckland").getTime(),
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

describe("searchByMeaning", () => {
  const query = { accountId: "account", text: SENTENCE, limit: 15 };

  it("gives up at the search's budget, so a model still downloading never holds the search", async () => {
    const pending = searchByMeaning(() => new Promise(() => undefined), query);
    await vi.advanceTimersByTimeAsync(CUE_SEARCH_BUDGET_MS);
    await expect(pending).resolves.toEqual([]);
  });

  it("finds nothing when the engine can't search by meaning", async () => {
    await expect(
      searchByMeaning(() => Promise.reject(new Error("no model")), query),
    ).resolves.toEqual([]);
    await expect(searchByMeaning(undefined, query)).resolves.toEqual([]);
  });
});

/** The window key of each tier of SEARCH's ladder, in order. */
function ladderKeys() {
  const ladder = getWideningLadder([SEARCH], {
    now: new Date(),
    provider: "google",
  });
  expect(ladder.map((step) => step.tier)).toEqual([
    "fewer_words",
    "sender_and_dates",
    "wider_dates",
  ]);
  return ladder.map((step) => step.searches.join(" | "));
}

function searchesOf(predicate: unknown): string[] {
  if (!predicate || typeof predicate !== "object") return [];
  const node = predicate as {
    kind: string;
    query?: string;
    predicates?: unknown[];
  };
  if (node.kind === "search" && node.query) return [node.query];
  if (node.kind === "message")
    return [`messages:${(node as unknown as { ids: string[] }).ids.join(",")}`];
  return (node.predicates ?? []).flatMap(searchesOf);
}

function findPredicate(predicate: unknown, kind: string): unknown {
  if (!predicate || typeof predicate !== "object") return;
  const node = predicate as {
    kind: string;
    predicates?: unknown[];
    local?: unknown;
  };
  if (node.kind === kind) return node;
  for (const child of [...(node.predicates ?? []), node.local]) {
    const found = findPredicate(child, kind);
    if (found) return found;
  }
  return;
}
