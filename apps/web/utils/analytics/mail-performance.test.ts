// @vitest-environment jsdom
import { log } from "next-axiom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMailPerformanceSummary,
  MAIL_PERFORMANCE_SAMPLE_RATE,
  recordMailMark,
  resetMailPerformanceForTesting,
  shouldSampleSession,
  summarizeDurations,
} from "@/utils/analytics/mail-performance";
import { scheduleSummaryFlush } from "@/utils/analytics/summary-flush";

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
vi.mock("@/utils/analytics/summary-flush", () => ({
  scheduleSummaryFlush: vi.fn(),
}));

describe("summarizeDurations", () => {
  it("reports nearest-rank percentiles of measured values", () => {
    const values = Array.from({ length: 100 }, (_, index) => 100 - index);

    expect(summarizeDurations(values)).toEqual({
      count: 100,
      p50: 50,
      p75: 75,
      p95: 95,
      max: 100,
    });
  });

  it("uses the only value for every percentile of a single sample", () => {
    expect(summarizeDurations([41.6])).toEqual({
      count: 1,
      p50: 42,
      p75: 42,
      p95: 42,
      max: 42,
    });
  });
});

describe("buildMailPerformanceSummary", () => {
  it("returns null when nothing was measured", () => {
    expect(
      buildMailPerformanceSummary({
        input_event: [],
        long_task: [],
        thread_switch: [],
        first_row_cached: [],
        first_row_fresh: [],
        compose_ready: [],
      }),
    ).toBeNull();
  });

  it("summarises only metrics with data and totals blocking time", () => {
    expect(
      buildMailPerformanceSummary({
        input_event: [],
        long_task: [60, 150],
        thread_switch: [20, 80],
        first_row_cached: [],
        first_row_fresh: [],
        compose_ready: [],
      }),
    ).toEqual({
      long_task_count: 2,
      long_task_p50_ms: 60,
      long_task_p75_ms: 150,
      long_task_p95_ms: 150,
      long_task_max_ms: 150,
      long_task_total_blocking_ms: 110,
      thread_switch_count: 2,
      thread_switch_p50_ms: 20,
      thread_switch_p75_ms: 80,
      thread_switch_p95_ms: 80,
      thread_switch_max_ms: 80,
    });
  });
});

describe("shouldSampleSession", () => {
  it("samples draws below the rate only", () => {
    expect(shouldSampleSession(0)).toBe(true);
    expect(shouldSampleSession(MAIL_PERFORMANCE_SAMPLE_RATE - 0.001)).toBe(
      true,
    );
    expect(shouldSampleSession(MAIL_PERFORMANCE_SAMPLE_RATE)).toBe(false);
    expect(shouldSampleSession(0.99)).toBe(false);
  });
});

describe("recordMailMark", () => {
  const capture = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    resetMailPerformanceForTesting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function flushSummary() {
    const flush = vi.mocked(scheduleSummaryFlush).mock.calls[0]?.[0];
    flush?.(capture);
    return vi.mocked(log.info).mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
  }

  it("sends nothing when the session is not sampled", () => {
    vi.spyOn(Math, "random").mockReturnValue(0.99);

    recordMailMark("first_row_cached", 120);
    recordMailMark("compose_ready", 80);

    expect(scheduleSummaryFlush).not.toHaveBeenCalled();
    expect(log.info).not.toHaveBeenCalled();
    expect(capture).not.toHaveBeenCalled();
  });

  it("reports the first row once per page, tagged by where rows came from", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    recordMailMark("first_row_cached", 120);
    recordMailMark("first_row_cached", 900);
    recordMailMark("first_row_fresh", 1500);

    const fields = flushSummary();
    expect(fields).toMatchObject({
      scope: "mail-performance",
      first_row_cached_count: 1,
      first_row_cached_p50_ms: 120,
    });
    expect(fields).not.toHaveProperty("first_row_fresh_count");
  });

  it("tags a network-backed first row as fresh", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    recordMailMark("first_row_fresh", 1500);

    const fields = flushSummary();
    expect(fields).toMatchObject({
      first_row_fresh_count: 1,
      first_row_fresh_p50_ms: 1500,
    });
    expect(fields).not.toHaveProperty("first_row_cached_count");
  });

  it("records each compose open and carries only numbers", () => {
    vi.spyOn(Math, "random").mockReturnValue(0);

    recordMailMark("compose_ready", 80);
    recordMailMark("compose_ready", 200);

    const fields = flushSummary() as Record<string, unknown>;
    expect(fields).toMatchObject({
      compose_ready_count: 2,
      compose_ready_p50_ms: 80,
      compose_ready_max_ms: 200,
    });
    for (const [key, value] of Object.entries(fields)) {
      if (key !== "scope") expect(typeof value).toBe("number");
    }
  });
});
