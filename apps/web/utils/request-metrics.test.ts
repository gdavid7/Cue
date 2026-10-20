import { describe, expect, it } from "vitest";
import {
  createRequestMetrics,
  getRequestMetricsFields,
  runWithRequestMetrics,
  timeRequestDependency,
} from "@/utils/request-metrics";

describe("request metrics", () => {
  it("attributes awaited work to its dependency, including across async hops", async () => {
    const metrics = createRequestMetrics();
    await runWithRequestMetrics(metrics, async () => {
      await timeRequestDependency("db", async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
      });
      await Promise.all([
        timeRequestDependency("redis", () => Promise.resolve(1)),
        timeRequestDependency("redis", () => Promise.resolve(2)),
      ]);
    });

    const fields = getRequestMetricsFields(metrics);
    expect(fields.dbMs).toBeGreaterThanOrEqual(15);
    expect(fields.dbCalls).toBe(1);
    expect(fields.redisCalls).toBe(2);
    expect(fields.authMs).toBe(0);
  });

  it("counts a call that throws and rethrows its error", async () => {
    const metrics = createRequestMetrics();
    await expect(
      runWithRequestMetrics(metrics, () =>
        timeRequestDependency("gmail", () => Promise.reject(new Error("x"))),
      ),
    ).rejects.toThrow("x");
    expect(getRequestMetricsFields(metrics).gmailCalls).toBe(1);
  });

  it("does not leak between concurrent requests and ignores calls outside one", async () => {
    const first = createRequestMetrics();
    const second = createRequestMetrics();
    await Promise.all([
      runWithRequestMetrics(first, () =>
        timeRequestDependency("db", () => Promise.resolve()),
      ),
      runWithRequestMetrics(second, () => Promise.resolve()),
    ]);
    await timeRequestDependency("db", () => Promise.resolve());

    expect(getRequestMetricsFields(first).dbCalls).toBe(1);
    expect(getRequestMetricsFields(second).dbCalls).toBe(0);
  });
});
