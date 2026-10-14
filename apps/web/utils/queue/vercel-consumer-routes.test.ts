import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const webRoot = path.resolve(import.meta.dirname, "../..");

// A queue consumer trusts the message in the request body. Vercel only keeps a
// route private when vercel.json declares it as a queue trigger; any other
// consumer route is public, so anyone could post a forged message to it.
describe("Vercel queue consumer routes", () => {
  it("are all declared as private queue triggers in vercel.json", () => {
    const vercelConfig = JSON.parse(
      readFileSync(path.join(webRoot, "vercel.json"), "utf8"),
    ) as {
      functions?: Record<
        string,
        { experimentalTriggers?: { type?: string }[] }
      >;
    };
    const triggeredRoutes = new Set(
      Object.entries(vercelConfig.functions ?? {})
        .filter(([, config]) =>
          config.experimentalTriggers?.some((trigger) =>
            trigger.type?.startsWith("queue/"),
          ),
        )
        .map(([file]) => file),
    );

    const consumerRoutes = findRouteFiles(path.join(webRoot, "app/api"))
      .filter((file) => isQueueConsumer(readFileSync(file, "utf8")))
      .map((file) => path.relative(webRoot, file).split(path.sep).join("/"));

    expect(consumerRoutes.length).toBeGreaterThan(0);
    expect(
      consumerRoutes.filter((route) => !triggeredRoutes.has(route)),
    ).toEqual([]);
  });
});

function isQueueConsumer(source: string) {
  return (
    /\bhandleCallback\b/.test(source) ||
    /\bcreateForwardingQueueHandler\b/.test(source)
  );
}

function findRouteFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return findRouteFiles(fullPath);
    return entry.name === "route.ts" ? [fullPath] : [];
  });
}
