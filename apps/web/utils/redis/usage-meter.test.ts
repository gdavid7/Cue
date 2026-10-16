import { afterEach, describe, expect, it, vi } from "vitest";
import type { Logger } from "@/utils/logger";
import { createRedisUsageMeter } from "./usage-meter";

describe("createRedisUsageMeter", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts each command by feature and the bytes it read", async () => {
    const meter = createRedisUsageMeter();
    const client = meter.wrap({
      get: async (_key: string) => "x".repeat(100),
      mget: async (..._keys: string[]) => ["a", "b"],
      eval: async (_script: string, _keys: string[], _args: string[]) => 1,
    });

    await client.get("inbox-insight:a1:m1");
    await client.mget("inbox-insight:a1:m1", "inbox-insight:a1:m2");
    await client.eval("return 1", ["gmail-quota:a1:bucket"], []);

    expect(meter.snapshot()).toEqual([
      { feature: "inbox-insight", commands: 2, bytesRead: 109 },
      { feature: "gmail-quota", commands: 1, bytesRead: 1 },
    ]);
  });

  // SCAN's first argument is a cursor; its match pattern names the feature.
  it("counts a scan under its match prefix", async () => {
    const meter = createRedisUsageMeter();
    const client = meter.wrap({
      scan: async (_cursor: string, _options: { match?: string }) => ["0", []],
    });

    await client.scan("0", { match: "usage-weekly-cost:*" });
    await client.scan("0", {});

    expect(meter.snapshot()).toEqual([
      { feature: "usage-weekly-cost", commands: 1, bytesRead: 8 },
      { feature: "scan", commands: 1, bytesRead: 8 },
    ]);
  });

  // Each command in a pipeline is billed, so a pipeline counts as many.
  it("counts a pipeline's commands when it runs", async () => {
    const meter = createRedisUsageMeter();
    const queued: string[] = [];
    const pipeline = {
      set(key: string) {
        queued.push(key);
        return pipeline;
      },
      exec: async () => queued.map(() => "OK"),
    };
    const client = meter.wrap({ pipeline: () => pipeline });

    const batch = client.pipeline();
    batch.set("gmail-thread-metadata:a1:t1").set("gmail-thread-metadata:a1:t2");
    expect(meter.snapshot()).toEqual([]);
    await batch.exec();

    expect(meter.snapshot()).toEqual([
      { feature: "gmail-thread-metadata", commands: 2, bytesRead: 4 },
    ]);
  });

  // Logged from request flushes, so a busy instance logs at most every few
  // minutes and Axiom can sum commands per feature per day.
  it("logs a summary at most once per interval, then starts over", () => {
    vi.useFakeTimers();
    const meter = createRedisUsageMeter();
    const logger = { info: vi.fn() } as unknown as Logger;
    meter.count("publish", "local-mail:a1", 2);

    meter.logSummary(logger);
    expect(logger.info).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 60_000);
    meter.logSummary(logger);
    meter.logSummary(logger);

    expect(logger.info).toHaveBeenCalledOnce();
    expect(logger.info).toHaveBeenCalledWith(
      "Redis usage",
      expect.objectContaining({
        commands: 1,
        byFeature: [{ feature: "local-mail", commands: 1, bytesRead: 2 }],
      }),
    );
    expect(meter.snapshot()).toEqual([]);
  });
});
