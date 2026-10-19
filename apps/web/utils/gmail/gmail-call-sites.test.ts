import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Gmail charges every request against one per-user budget, and the quota gate
// can only keep the account inside it if it sees every request. These are the
// only places that reach Gmail, and each one admits through the gate: the
// client factory meters every attempt its REST client sends, the batch
// helper charges each inner request, and the resumable draft upload meters
// its session request. A new way to reach Gmail must go through one of them.
const ALLOWED: Record<string, RegExp> = {
  "utils/gmail/client.ts":
    /from "@googleapis\/gmail"|\bgetGoogleGmailApiRootUrl\(/,
  "utils/gmail/batch.ts": /\bgetGoogleGmailBatchUrl\(/,
  "utils/gmail/resumable-draft-upload.ts": /\bgetGoogleGmailApiRootUrl\(/,
  "utils/gmail/oauth.ts":
    /gmail\.googleapis\.com|\bgetGoogleGmailBatchUrl\(|\bgetGoogleGmailApiRootUrl\(/,
};
const GMAIL_ACCESS = [
  // A Gmail REST client or auth client built outside the metered factory.
  /^import\s+(?!type\b)[^;]*?from\s+"@googleapis\/gmail"/m,
  /require\(\s*"@googleapis\/gmail"\s*\)/,
  /from\s+"googleapis"/,
  // Raw requests to Gmail's REST, batch or upload endpoints.
  /gmail\.googleapis\.com/,
  /\bgetGoogleGmailBatchUrl\(/,
  /\bgetGoogleGmailApiRootUrl\(/,
];
const APP_ROOT = join(import.meta.dirname, "..", "..");
const SKIPPED_DIRS = new Set([
  "node_modules",
  ".next",
  "generated",
  "__tests__",
  "public",
]);

describe("Gmail call sites", () => {
  it("reach Gmail only through the metered client, batch and upload helpers", () => {
    const unmetered = sourceFiles(APP_ROOT).flatMap((file) => {
      const path = relative(APP_ROOT, file).split(sep).join("/");
      const source = readFileSync(file, "utf8");
      const allowed = ALLOWED[path];
      return GMAIL_ACCESS.filter((pattern) => {
        const match = source.match(pattern);
        return match && !allowed?.test(match[0]);
      }).map((pattern) => `${path}: ${pattern}`);
    });

    expect(unmetered).toEqual([]);
  });

  // Gmail also refuses a user's requests past how many it has in flight, so
  // each place that sends holds the account's in-flight slots while it does.
  it("send only while holding the account's in-flight slots", () => {
    const senders = Object.keys(ALLOWED).filter(
      (path) => path !== "utils/gmail/oauth.ts",
    );
    const uncapped = senders.filter(
      (path) =>
        !readFileSync(join(APP_ROOT, path), "utf8").includes(
          "withGmailInflightSlot(",
        ),
    );

    expect(uncapped).toEqual([]);
  });
});

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.isDirectory())
      return SKIPPED_DIRS.has(entry.name)
        ? []
        : sourceFiles(join(dir, entry.name));
    const isSource = /\.(ts|tsx)$/.test(entry.name);
    const isTest = /\.(test|spec|bench)\.tsx?$/.test(entry.name);
    return isSource && !isTest ? [join(dir, entry.name)] : [];
  });
}
