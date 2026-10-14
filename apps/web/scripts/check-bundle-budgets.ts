import { readFileSync } from "node:fs";
import path from "node:path";
import { gzipSync } from "node:zlib";

// First-load JavaScript (gzip) that each entry point may download before it
// becomes interactive. A phone pays for every kilobyte twice, downloading and
// then parsing it, so growth here should be a decision rather than an
// accident. Raise a budget only with the reason in the commit message.
export const FIRST_LOAD_JS_BUDGETS_KB: Record<string, number> = {
  "/login": 585,
  "/mail/u/[accountIndex]/[[...view]]": 1220,
  "/[emailAccountId]/home": 1085,
  "/settings": 1045,
};

type RouteBundleStats = {
  route: string;
  firstLoadChunkPaths: string[];
};

export function findBudgetOverruns(
  stats: RouteBundleStats[],
  budgetsKb: Record<string, number>,
  gzipSizeOf: (chunkPath: string) => number,
) {
  return Object.entries(budgetsKb).map(([route, budgetKb]) => {
    const entry = stats.find((item) => item.route === route);
    if (!entry) return { route, budgetKb, sizeKb: null, over: true };
    const bytes = entry.firstLoadChunkPaths.reduce(
      (total, chunk) => total + gzipSizeOf(chunk),
      0,
    );
    const sizeKb = Math.round(bytes / 1024);
    return { route, budgetKb, sizeKb, over: sizeKb > budgetKb };
  });
}

function main() {
  const appRoot = path.resolve(import.meta.dirname, "..");
  const stats = JSON.parse(
    readFileSync(
      path.join(appRoot, ".next/diagnostics/route-bundle-stats.json"),
      "utf8",
    ),
  ) as RouteBundleStats[];
  const results = findBudgetOverruns(
    stats,
    FIRST_LOAD_JS_BUDGETS_KB,
    (chunk) => gzipSync(readFileSync(path.join(appRoot, chunk))).length,
  );
  for (const { route, budgetKb, sizeKb, over } of results) {
    console.log(
      `${over ? "OVER" : "ok  "} ${String(sizeKb ?? "missing").padStart(5)} / ${budgetKb} KB gzip  ${route}`,
    );
  }
  if (results.some((result) => result.over)) {
    console.error(
      "First-load JavaScript is over budget. Lazy-load what the first screen does not need, or raise the budget deliberately.",
    );
    process.exit(1);
  }
}

if (process.argv[1] === import.meta.filename) main();
