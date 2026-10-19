// @vitest-environment jsdom
import { log } from "next-axiom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginRumAction,
  bucketHoursSinceLastSync,
  buildRumEvent,
  cancelRumAction,
  completeRumAction,
  markRumRowsShown,
  observeRumConfirmation,
  RUM_SAMPLE_RATE,
  recordRumAction,
  resetRumActionsForTesting,
  rumSampleRate,
  setRumContext,
} from "@/utils/analytics/rum-actions";

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

const EVENT_FIELDS = [
  "accountCount",
  "device",
  "hoursSinceLastSync",
  "ms",
  "name",
  "outcome",
  "provider",
  "sampleRate",
];
const PII_FIELD_NAME = /email|subject|snippet|query|body/i;
const HOUR_MS = 60 * 60 * 1000;

describe("bucketHoursSinceLastSync", () => {
  const now = 1000 * HOUR_MS;

  it.each([
    [null, "unknown"],
    [now + 1, "unknown"],
    [now - 0.5 * HOUR_MS, "lt1h"],
    [now - 1 * HOUR_MS, "1to6h"],
    [now - 5.9 * HOUR_MS, "1to6h"],
    [now - 6 * HOUR_MS, "6to24h"],
    [now - 23.9 * HOUR_MS, "6to24h"],
    [now - 24 * HOUR_MS, "gt24h"],
    [now - 500 * HOUR_MS, "gt24h"],
  ])("puts %s into %s", (lastSyncAt, expected) => {
    expect(bucketHoursSinceLastSync(lastSyncAt, now)).toBe(expected);
  });
});

describe("rumSampleRate", () => {
  it("sends every app open and every error or timeout", () => {
    expect(rumSampleRate("app_open_returning", "ok")).toBe(1);
    expect(rumSampleRate("app_open_cold", "empty")).toBe(1);
    expect(rumSampleRate("archive_optimistic", "error")).toBe(1);
    expect(rumSampleRate("search_plain", "timeout")).toBe(1);
  });

  it("samples other successes at the configured rate", () => {
    expect(rumSampleRate("thread_open", "ok")).toBe(RUM_SAMPLE_RATE);
    expect(rumSampleRate("compose_open", "empty")).toBe(RUM_SAMPLE_RATE);
    expect(RUM_SAMPLE_RATE).toBe(0.1);
  });
});

describe("buildRumEvent", () => {
  const context = {
    provider: "google",
    accountCount: 2,
    hoursSinceLastSync: "gt24h",
  } as const;

  it("carries exactly the agreed fields", () => {
    const event = buildRumEvent({
      name: "thread_open",
      ms: 41.6,
      outcome: "ok",
      sampleRate: 0.1,
      context,
      viewportWidth: 1280,
    });

    expect(event).toEqual({
      name: "thread_open",
      ms: 42,
      outcome: "ok",
      provider: "google",
      accountCount: 2,
      hoursSinceLastSync: "gt24h",
      device: "desktop",
      sampleRate: 0.1,
    });
  });

  it("classes narrow viewports as mobile", () => {
    const build = (viewportWidth: number) =>
      buildRumEvent({
        name: "compose_open",
        ms: 1,
        outcome: "ok",
        sampleRate: 1,
        context,
        viewportWidth,
      }).device;

    expect(build(767)).toBe("mobile");
    expect(build(768)).toBe("desktop");
  });

  it("cannot carry a PII field, even when handed one", () => {
    const hostile = {
      name: "search_plain",
      ms: 10,
      outcome: "ok",
      sampleRate: 0.1,
      context: {
        ...context,
        email: "someone@example.com",
        subject: "Quarterly numbers",
      },
      viewportWidth: 1000,
      email: "someone@example.com",
      subject: "Quarterly numbers",
      snippet: "Hi there",
      query: "from:boss",
      body: "secret",
    } as unknown as Parameters<typeof buildRumEvent>[0];

    const event = buildRumEvent(hostile);

    expect(Object.keys(event).sort()).toEqual(EVENT_FIELDS);
    for (const field of Object.keys(event)) {
      expect(field).not.toMatch(PII_FIELD_NAME);
    }
    expect(JSON.stringify(event)).not.toMatch(
      /someone@example|Quarterly|Hi there|from:boss|secret/,
    );
  });
});

describe("sending events", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetRumActionsForTesting();
    setRumContext({
      accountId: "acct_1",
      provider: "microsoft",
      accountCount: 3,
    });
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    localStorage.clear();
  });

  function sent() {
    return vi.mocked(log.info).mock.calls.map(([, fields]) => fields);
  }

  it("logs one structured event per measurement with only allowed fields", () => {
    recordRumAction("archive_confirmed", performance.now() - 250);

    expect(sent()).toHaveLength(1);
    const [event] = sent() as Record<string, unknown>[];
    expect(event).toMatchObject({
      scope: "rum",
      name: "archive_confirmed",
      outcome: "ok",
      provider: "microsoft",
      accountCount: 3,
      device: expect.stringMatching(/^(mobile|desktop)$/),
    });
    expect(
      Object.keys(event)
        .filter((key) => key !== "scope")
        .sort(),
    ).toEqual(EVENT_FIELDS);
    for (const field of Object.keys(event)) {
      expect(field).not.toMatch(PII_FIELD_NAME);
    }
  });

  it("drops unsampled successes but keeps errors", () => {
    vi.mocked(Math.random).mockReturnValue(0.5);

    recordRumAction("star_confirmed", performance.now() - 5);
    expect(sent()).toHaveLength(0);

    recordRumAction("star_confirmed", performance.now() - 5, "error");
    expect(sent()).toHaveLength(1);
  });

  it("drops timings that are not real waits", () => {
    recordRumAction("thread_open", performance.now() + 1000);
    recordRumAction("thread_open", performance.now() - 11 * 60 * 1000);

    expect(sent()).toHaveLength(0);
  });

  it("measures a begun action from its start once it is painted", async () => {
    beginRumAction("compose_open", { startedAt: performance.now() - 300 });

    expect(completeRumAction("compose_open")).toBe(true);
    expect(sent()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(50);

    expect(sent()).toHaveLength(1);
    expect((sent()[0] as { ms: number }).ms).toBeGreaterThanOrEqual(300);
    expect(completeRumAction("compose_open")).toBe(false);
  });

  it("ignores a completion for another key", async () => {
    beginRumAction("thread_open", { key: "a" });

    expect(completeRumAction("thread_open", { key: "b" })).toBe(false);
    expect(completeRumAction("thread_open", { key: "a" })).toBe(true);
    await vi.advanceTimersByTimeAsync(50);
    expect(sent()).toHaveLength(1);
  });

  it("sends nothing for a cancelled action", async () => {
    beginRumAction("compose_open");
    cancelRumAction("compose_open");
    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

    expect(sent()).toHaveLength(0);
  });

  it("reports an action that never finishes as a timeout", async () => {
    beginRumAction("reply_suggestion", { key: "m1" });
    await vi.advanceTimersByTimeAsync(61_000);

    expect(sent()).toHaveLength(1);
    expect(sent()[0]).toMatchObject({
      name: "reply_suggestion",
      outcome: "timeout",
    });
  });

  it("ends an app open when the first rows are shown, always sent", async () => {
    beginRumAction("app_open_returning", { startedAt: 0 });
    vi.mocked(Math.random).mockReturnValue(0.99);

    markRumRowsShown();
    await vi.advanceTimersByTimeAsync(50);

    expect(sent()[0]).toMatchObject({
      name: "app_open_returning",
      outcome: "ok",
      sampleRate: 1,
    });
  });

  it("reads hours since the last sync from before this session", () => {
    localStorage.setItem(
      "cue-rum-last-sync:acct_2",
      String(Date.now() - 30 * HOUR_MS),
    );
    setRumContext({ accountId: "acct_2", provider: "google", accountCount: 1 });

    recordRumAction("thread_open", performance.now() - 5);

    expect(sent()[0]).toMatchObject({
      provider: "google",
      hoursSinceLastSync: "gt24h",
    });
  });
});

describe("observeRumConfirmation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    resetRumActionsForTesting();
    vi.spyOn(Math, "random").mockReturnValue(0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function fakeClient() {
    let status = "queued";
    const listeners = new Set<() => void>();
    const close = vi.fn();
    const client = {
      observeOperation: () => ({
        getSnapshot: () => ({ data: { status } }),
        subscribe: (listener: () => void) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        close,
      }),
    };
    return {
      client: client as never,
      close,
      settle(next: string) {
        status = next;
        for (const listener of listeners) listener();
      },
    };
  }

  const input = { accountId: "acct_1", operationId: "op_1" };

  it("reports the server's answer once, then lets the observation go", () => {
    const fake = fakeClient();
    observeRumConfirmation({
      ...input,
      client: fake.client,
      name: "archive_confirmed",
      startedAt: performance.now() - 120,
    });

    fake.settle("executing");
    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
    fake.settle("succeeded");
    fake.settle("failed");

    expect(vi.mocked(log.info)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(log.info).mock.calls[0][1]).toMatchObject({
      name: "archive_confirmed",
      outcome: "ok",
    });
    expect(fake.close).toHaveBeenCalledTimes(1);
  });

  it("reports a failed operation as an error", () => {
    const fake = fakeClient();
    observeRumConfirmation({
      ...input,
      client: fake.client,
      name: "star_confirmed",
      startedAt: performance.now(),
    });

    fake.settle("failed");

    expect(vi.mocked(log.info).mock.calls[0][1]).toMatchObject({
      outcome: "error",
    });
  });

  it("says nothing when an undo cancels the operation", () => {
    const fake = fakeClient();
    observeRumConfirmation({
      ...input,
      client: fake.client,
      name: "archive_confirmed",
      startedAt: performance.now(),
    });

    fake.settle("cancelled");

    expect(vi.mocked(log.info)).not.toHaveBeenCalled();
    expect(fake.close).toHaveBeenCalledTimes(1);
  });
});
