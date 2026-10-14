import { describe, expect, it } from "vitest";
import { findBudgetOverruns } from "./check-bundle-budgets";

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
