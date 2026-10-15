import { afterEach, describe, expect, it, vi } from "vitest";
import { startEngineLoop } from "./engine-loop";

afterEach(() => {
  vi.useRealTimers();
});

describe("startEngineLoop", () => {
  it("keeps running the engine's work in turns", async () => {
    vi.useFakeTimers();
    const runUntil = vi.fn(async () => {});
    const loop = startEngineLoop({ runUntil });

    await vi.advanceTimersByTimeAsync(1000);

    expect(runUntil.mock.calls.length).toBeGreaterThan(1);
    await stopWithin(loop, 0);
  });

  it("stops at once while a turn waits on sync", async () => {
    vi.useFakeTimers();
    const loop = startEngineLoop({ runUntil: waitUntilAborted });
    await vi.advanceTimersByTimeAsync(10);

    await stopWithin(loop, 0);
  });

  it("stops at once when a turn fails as the engine closes", async () => {
    vi.useFakeTimers();
    // Closing aborts the sync lanes, and the turn then reports their failure.
    const loop = startEngineLoop({
      runUntil: async (_deadline, signal) => {
        await waitUntilAborted(_deadline, signal);
        throw new Error("Mail sync lanes failed");
      },
    });
    await vi.advanceTimersByTimeAsync(10);

    await stopWithin(loop, 0);
  });

  it("waits a moment after a failed turn before the next", async () => {
    vi.useFakeTimers();
    const runUntil = vi.fn(async () => {
      throw new Error("offline");
    });
    const loop = startEngineLoop({ runUntil });

    await vi.advanceTimersByTimeAsync(500);

    expect(runUntil).toHaveBeenCalledTimes(1);
    await stopWithin(loop, 0);
  });
});

async function stopWithin(
  loop: ReturnType<typeof startEngineLoop>,
  ms: number,
) {
  let stopped = false;
  const stopping = loop.stop().then(() => {
    stopped = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  expect(stopped).toBe(true);
  await stopping;
}

function waitUntilAborted(_deadlineMs: number, signal?: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) resolve();
    signal?.addEventListener("abort", () => resolve(), { once: true });
  });
}
