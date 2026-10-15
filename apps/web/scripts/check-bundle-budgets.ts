import { existsSync, readFileSync } from "node:fs";
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

// The mail engine, its store and SQLite run in a dedicated worker. Text that
// survives minification marks each, so finding it in a page's first load
// means an import pulled the worker's code onto the page.
const WORKER_ONLY_CODE_MARKERS: Record<string, string> = {
  installOpfsSAHPoolVfs: "sqlite-wasm",
  "CREATE TABLE IF NOT EXISTS": "the mail store's SQL",
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

export function findWorkerOnlyCode(
  stats: RouteBundleStats[],
  routes: string[],
  readChunk: (chunkPath: string) => string,
) {
  return stats
    .filter((entry) => routes.includes(entry.route))
    .flatMap((entry) =>
      entry.firstLoadChunkPaths.flatMap((chunk) => {
        const source = readChunk(chunk);
        return Object.entries(WORKER_ONLY_CODE_MARKERS)
          .filter(([marker]) => source.includes(marker))
          .map(([, code]) => ({ route: entry.route, chunk, code }));
      }),
    );
}

/** The per-route first-load chunks a Turbopack production build records. */
export function readRouteBundleStats(appRoot: string): RouteBundleStats[] {
  const statsPath = path.join(
    appRoot,
    ".next/diagnostics/route-bundle-stats.json",
  );
  if (!existsSync(statsPath)) {
    throw new Error(
      `No ${path.relative(appRoot, statsPath)} found. Run a Turbopack production build (next build) first; other builds do not write it.`,
    );
  }
  return JSON.parse(readFileSync(statsPath, "utf8")) as RouteBundleStats[];
}

function main() {
  const appRoot = path.resolve(import.meta.dirname, "..");
  let stats: RouteBundleStats[];
  try {
    stats = readRouteBundleStats(appRoot);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
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
  const workerCode = findWorkerOnlyCode(
    stats,
    Object.keys(FIRST_LOAD_JS_BUDGETS_KB),
    (chunk) => readFileSync(path.join(appRoot, chunk), "utf8"),
  );
  for (const { route, chunk, code } of workerCode) {
    console.log(`WORKER-ONLY ${code} in ${chunk}  ${route}`);
  }
  if (results.some((result) => result.over)) {
    console.error(
      "First-load JavaScript is over budget. Lazy-load what the first screen does not need, or raise the budget deliberately.",
    );
  }
  if (workerCode.length) {
    console.error(
      "A page's first load carries the mail worker's code. Import what the page needs from a module that does not bring the store or SQLite with it.",
    );
  }
  if (results.some((result) => result.over) || workerCode.length) {
    process.exit(1);
  }
}

if (process.argv[1] === import.meta.filename) main();
