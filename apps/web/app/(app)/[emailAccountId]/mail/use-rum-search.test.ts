// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { log } from "next-axiom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  noteRumSearchCommit,
  resetRumSearchForTesting,
  useRumSearch,
} from "@/app/(app)/[emailAccountId]/mail/use-rum-search";
import { resetRumActionsForTesting } from "@/utils/analytics/rum-actions";

vi.mock("next-axiom", () => ({
  log: {
    info: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_AXIOM_TOKEN: "test-token" },
}));

type Props = Parameters<typeof useRumSearch>[0];

const NOTHING = { hasRows: false, empty: false };
const idle: Props = {
  committedQuery: null,
  plain: NOTHING,
  plainError: false,
  cue: { ...NOTHING, active: false },
};

describe("useRumSearch", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetRumActionsForTesting();
    resetRumSearchForTesting();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function sent() {
    return vi
      .mocked(log.info)
      .mock.calls.map(([, fields]) => fields as Record<string, unknown>);
  }

  it("times each commit on its own, even when the results look the same", async () => {
    const view = renderHook((props: Props) => useRumSearch(props), {
      initialProps: idle,
    });
    const rows = { hasRows: true, empty: false };

    noteRumSearchCommit("invoice");
    view.rerender({ ...idle, committedQuery: "invoice", plain: rows });
    await vi.advanceTimersByTimeAsync(50);
    noteRumSearchCommit("receipt");
    view.rerender({ ...idle, committedQuery: "receipt", plain: rows });
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sent().map((event) => [event.name, event.outcome])).toEqual([
      ["search_plain", "ok"],
      ["search_plain", "ok"],
    ]);
  });

  it("does not wait on a repeated commit of the search already shown", async () => {
    const view = renderHook((props: Props) => useRumSearch(props), {
      initialProps: idle,
    });
    noteRumSearchCommit("invoice");
    view.rerender({
      ...idle,
      committedQuery: "invoice",
      plain: { hasRows: true, empty: false },
    });
    await vi.advanceTimersByTimeAsync(50);
    vi.clearAllMocks();

    noteRumSearchCommit("invoice");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sent()).toHaveLength(0);
  });

  it("times Cue found only when Cue's search runs", async () => {
    const view = renderHook((props: Props) => useRumSearch(props), {
      initialProps: idle,
    });
    const plain = { hasRows: true, empty: false };

    noteRumSearchCommit("show me unpaid invoices");
    view.rerender({
      ...idle,
      committedQuery: "show me unpaid invoices",
      plain,
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    expect(sent().map((event) => event.name)).toEqual(["search_plain"]);

    vi.clearAllMocks();
    noteRumSearchCommit("what did acme send me");
    view.rerender({
      ...idle,
      committedQuery: "what did acme send me",
      plain,
      cue: { hasRows: true, empty: false, active: true },
    });
    await vi.advanceTimersByTimeAsync(50);

    expect(
      sent()
        .map((event) => event.name)
        .sort(),
    ).toEqual(["search_cue_found", "search_plain"]);
  });

  it("reports an empty search as empty, not as a timeout", async () => {
    const view = renderHook((props: Props) => useRumSearch(props), {
      initialProps: idle,
    });

    noteRumSearchCommit("zzz");
    view.rerender({
      ...idle,
      committedQuery: "zzz",
      plain: { hasRows: false, empty: true },
    });
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sent().map((event) => event.outcome)).toEqual(["empty"]);
  });
});
