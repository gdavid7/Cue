import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  findBudgetOverruns,
  findWorkerOnlyCode,
  readRouteBundleStats,
} from "./check-bundle-budgets";

describe("findBudgetOverruns", () => {
  const sizes: Record<string, number> = {
    "shared.js": 300 * 1024,
    "mail.js": 500 * 1024,
  };
  const stats = [
    { route: "/login", firstLoadChunkPaths: ["shared.js"] },
    { route: "/mail", firstLoadChunkPaths: ["shared.js", "mail.js"] },
  ];

  it("sums a route's first-load chunks against its budget", () => {
    expect(
      findBudgetOverruns(
        stats,
        { "/login": 400, "/mail": 700 },
        (chunk) => sizes[chunk],
      ),
    ).toEqual([
      { route: "/login", budgetKb: 400, sizeKb: 300, over: false },
      { route: "/mail", budgetKb: 700, sizeKb: 800, over: true },
    ]);
  });

  it("fails a budgeted route the build no longer reports", () => {
    expect(
      findBudgetOverruns(stats, { "/renamed": 100 }, (chunk) => sizes[chunk]),
    ).toEqual([{ route: "/renamed", budgetKb: 100, sizeKb: null, over: true }]);
  });
});

describe("readRouteBundleStats", () => {
  it("explains a build that wrote no route bundle stats", () => {
    const appRoot = mkdtempSync(path.join(tmpdir(), "bundle-budgets-"));
    try {
      expect(() => readRouteBundleStats(appRoot)).toThrow(
        /route-bundle-stats\.json.*Turbopack production build/s,
      );
    } finally {
      rmSync(appRoot, { recursive: true, force: true });
    }
  });
});

describe("findWorkerOnlyCode", () => {
  it("names a first-load chunk that carries code meant for the mail worker", () => {
    const chunks: Record<string, string> = {
      "shared.js": "console.log('page')",
      "mail.js": 'db.exec("CREATE TABLE IF NOT EXISTS messages (id)")',
      "worker.js": "sqlite.installOpfsSAHPoolVfs({})",
    };
    const stats = [
      { route: "/login", firstLoadChunkPaths: ["shared.js"] },
      { route: "/mail", firstLoadChunkPaths: ["shared.js", "mail.js"] },
    ];

    expect(
      findWorkerOnlyCode(stats, ["/login", "/mail"], (chunk) => chunks[chunk]),
    ).toEqual([
      { route: "/mail", chunk: "mail.js", code: "the mail store's SQL" },
    ]);
  });
});
