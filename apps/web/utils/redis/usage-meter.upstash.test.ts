import { Redis } from "@upstash/redis";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRedisUsageMeter } from "./usage-meter";

describe("usage meter around the Upstash client", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The meter relies on the client's pipeline methods returning the pipeline
  // itself; if a client upgrade changes that, queued commands go uncounted.
  it("counts each command of a chained Upstash pipeline", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json([{ result: "OK" }, { result: "OK" }])),
    );
    const meter = createRedisUsageMeter();
    const redis = meter.wrap(
      new Redis({ url: "http://127.0.0.1:1", token: "unused" }),
    );

    await redis.pipeline().set("a:1", "x").set("a:2", "y").exec();

    expect(meter.snapshot()).toEqual([
      { feature: "a", commands: 2, bytesRead: 4 },
    ]);
  });
});
