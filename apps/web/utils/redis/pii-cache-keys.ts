import { hashAddressForKey } from "@/utils/redis/address-key";
import { readWeeklyCostsByDay } from "@/utils/redis/usage-migration-state";

/**
 * RD-3: keys written before Cue stopped keeping email content and personal
 * data in Redis. Each still expires on its own (30 days at most) except the
 * legacy usage counters and migration records; this clears them now.
 * Running it again finds nothing more to do. Run it at least 15 minutes after
 * the RD-3 deploy is fully live, so no older instance is still writing them.
 */
type Pattern = {
  match: string;
  holds: string;
  /** Keys under the pattern that the current code writes and may stay. */
  keep?: (key: string) => boolean;
  /**
   * For a prefix the current code still writes, without the personal data:
   * only values this accepts are deleted. Reads each value to decide.
   */
  holdsPii?: (value: unknown) => boolean;
};

const HASHED_SUFFIX = /:[0-9a-f]{64}$/;

export const PII_KEY_PATTERNS: Pattern[] = [
  { match: "summary:*", holds: "email summaries" },
  { match: "reply:*", holds: "drafted replies" },
  { match: "research:*", holds: "web research about meeting guests" },
  { match: "thread-page:v2:*", holds: "encrypted pages of threads" },
  { match: "gmail-thread-metadata:*", holds: "Gmail thread headers" },
  { match: "thread-brief:*", holds: "AI briefs of threads" },
  { match: "thread-context:*", holds: "related mail, events and pages" },
  { match: "linked-page:*", holds: "pages linked from emails" },
  { match: "suggested-reply:v2:*", holds: "suggested replies" },
  { match: "suggested-reply-web:v2:*", holds: "suggested replies" },
  { match: "inbox-insight:*", holds: "insights and people on emails" },
  { match: "own-addresses:*", holds: "the user's addresses" },
  { match: "account:*", holds: "account addresses from ownership checks" },
  { match: "contact-photos:*", holds: "contact photos by address" },
  { match: "home-deadlines:*", holds: "connected-app task titles" },
  { match: "label-counts:*", holds: "label names with counts" },
  {
    // Deep Clean still writes thread:{account}:{job}:{thread} for 6 hours, with
    // ids and status only. Only the older entries named the sender.
    match: "thread:*",
    holds: "Deep Clean threads with sender and subject",
    holdsPii: (value) =>
      typeof value === "object" &&
      value !== null &&
      ["from", "subject", "snippet"].some((field) => field in value),
  },
  { match: "local-mail-categories:*", holds: "Outlook category names" },
  {
    match: "meeting-news:*",
    holds: "news keyed by the organization's name",
    keep: (key) => HASHED_SUFFIX.test(key),
  },
  {
    match: "jira-cloud-id:*",
    holds: "Jira sites from links in mail",
    keep: (key) => HASHED_SUFFIX.test(key),
  },
  {
    match: "processing-message-failures:*@*",
    holds: "failure counts keyed by the mailbox address",
  },
  {
    match: "usage-weekly-cost:*@*",
    holds: "weekly AI cost keyed by address",
  },
  {
    match: "inbox-zero:chat-sdk:list:msg-history:*",
    holds: "Telegram thread messages",
  },
  {
    match: "inbox-zero:chat-sdk:list:transcripts:*",
    holds: "chat transcripts",
  },
  {
    match: "inbox-zero:chat-sdk:cache:modal-context:*",
    holds: "modal contexts that may quote messages",
  },
  {
    match: "inbox-zero:chat-sdk:queue:*",
    holds: "queued bot messages",
  },
  {
    // Counters not yet migrated to the account's key are dropped with them.
    match: "usage:*@*",
    holds: "lifetime AI usage counters keyed by address",
  },
];

// A message claimed or marked processed under the address. Handled ones are
// renamed to the hashed key, TTL and all, so a catch-up still skips them; a
// claim still in flight is left to expire with the run that holds it.
const LEGACY_CLAIM_PATTERN = "processing-message:*@*";

// Weekly-spend migration records written before RD-3 were keyed by legacy
// keys that named the address; the current code keys them by day.
const WEEKLY_MIGRATION_PATTERN =
  "usage-migration:weekly-usage-cost-user:*:done";

export type CleanupRedis = {
  scan(
    cursor: string | number,
    options: { match: string; count: number },
  ): Promise<[string | number, string[]]>;
  get(key: string): Promise<unknown>;
  mget(...keys: string[]): Promise<unknown[]>;
  set(key: string, value: string): Promise<unknown>;
  unlink(...keys: string[]): Promise<number>;
  renamenx(source: string, destination: string): Promise<number>;
};

const SCAN_COUNT = 300;
const UNLINK_CHUNK = 100;
const REDIS_FAILURE = "Redis command failed during PII cleanup";

type Phase = {
  match: string;
  matches: RegExp;
  holds: string;
  verb: { dryRun: string; done: string };
  /** Handles this pattern's keys from one SCAN batch; returns how many it counted. */
  process: (keys: string[]) => Promise<number>;
};

/**
 * Runs the cleanup from `cursor` (null to start) until it finishes or
 * `budgetMs` has passed, always completing at least one SCAN batch. One SCAN
 * over the whole keyspace; each key is sorted into its pattern here. Returns
 * the counts for this call only, per pattern, and the cursor to continue
 * from, or null when the keyspace has been covered. Names no key and carries
 * no value in its result. A Redis failure surfaces as a fixed message,
 * because the client's own errors quote the command, keys and values.
 */
export async function runPiiCleanupStep({
  redis: rawRedis,
  dryRun,
  cursor = null,
  budgetMs = Number.POSITIVE_INFINITY,
  now = Date.now,
}: {
  redis: CleanupRedis;
  dryRun: boolean;
  cursor?: string | null;
  budgetMs?: number;
  now?: () => number;
}) {
  if (cursor !== null && (!/^\d+$/.test(cursor) || cursor === "0"))
    throw new Error("Invalid cleanup cursor");

  const redis = withoutCommandDetails(rawRedis);
  const phases = buildPhases(redis, dryRun);
  const counts = Object.fromEntries(phases.map((phase) => [phase.match, 0]));
  const startedAt = now();
  let scan = cursor ?? "0";

  do {
    const [next, keys] = await redis.scan(scan, {
      match: "*",
      count: SCAN_COUNT,
    });
    scan = String(next);

    const byPhase = new Map<Phase, string[]>();
    for (const key of keys) {
      const phase = phases.find((candidate) => candidate.matches.test(key));
      if (phase) byPhase.set(phase, [...(byPhase.get(phase) ?? []), key]);
    }
    for (const [phase, phaseKeys] of byPhase)
      counts[phase.match] += await phase.process(phaseKeys);

    if (scan !== "0" && now() - startedAt >= budgetMs)
      return { counts, nextCursor: scan };
  } while (scan !== "0");

  return { counts, nextCursor: null };
}

/** The whole cleanup in one go, for the script. */
export async function deletePiiCacheKeys({
  redis,
  dryRun = false,
  log = () => {},
}: {
  redis: CleanupRedis;
  dryRun?: boolean;
  log?: (line: string) => void;
}) {
  const totals: Record<string, number> = {};
  let cursor: string | null = null;
  do {
    const step = await runPiiCleanupStep({ redis, dryRun, cursor });
    for (const [match, count] of Object.entries(step.counts))
      totals[match] = (totals[match] ?? 0) + count;
    cursor = step.nextCursor;
  } while (cursor);

  for (const phase of buildPhases(redis, dryRun))
    log(
      `${dryRun ? phase.verb.dryRun : phase.verb.done} ${totals[phase.match]} ${phase.match} (${phase.holds})`,
    );

  return totals;
}

function buildPhases(redis: CleanupRedis, dryRun: boolean): Phase[] {
  const deletePhases = PII_KEY_PATTERNS.map(
    (pattern): Phase => ({
      match: pattern.match,
      matches: globToRegExp(pattern.match),
      holds: pattern.holds,
      verb: { dryRun: "would delete", done: "deleted" },
      process: async (batch) => {
        let keys = batch.filter((key) => !pattern.keep?.(key));
        if (pattern.holdsPii && keys.length) {
          const holdsPii = pattern.holdsPii;
          const values = await redis.mget(...keys);
          keys = keys.filter((_, index) => holdsPii(values[index]));
        }
        if (!dryRun)
          for (let start = 0; start < keys.length; start += UNLINK_CHUNK)
            await redis.unlink(...keys.slice(start, start + UNLINK_CHUNK));
        return keys.length;
      },
    }),
  );

  const claimPhase: Phase = {
    match: LEGACY_CLAIM_PATTERN,
    matches: globToRegExp(LEGACY_CLAIM_PATTERN),
    holds: "to hashed keys",
    verb: { dryRun: "would rename", done: "renamed" },
    process: async (keys) => {
      let renamed = 0;
      for (const key of keys) {
        const destination = hashedClaimKey(key);
        if (!destination || !isSettledClaim(await redis.get(key))) continue;
        renamed++;
        if (dryRun) continue;
        if (await redis.renamenx(key, destination)) continue;
        // The hashed key is the newer claim. The legacy one goes only when
        // that is settled too; a live lock keeps the old key until it
        // expires, so the message is not taken twice.
        if (isSettledClaim(await redis.get(destination)))
          await redis.unlink(key);
      }
      return renamed;
    },
  };

  const migrationPhase: Phase = {
    match: WEEKLY_MIGRATION_PATTERN,
    matches: globToRegExp(WEEKLY_MIGRATION_PATTERN),
    holds: "by day",
    verb: { dryRun: "would rewrite", done: "rewrote" },
    process: async (keys) => {
      let rewritten = 0;
      for (const key of keys) {
        const record = readWeeklyCostsByDay(await redis.get(key));
        if (!record?.keyedByAddress) continue;
        rewritten++;
        if (!dryRun)
          await redis.set(
            key,
            JSON.stringify({
              weeklyCostsByDay: Object.fromEntries(record.costsByDay),
            }),
          );
      }
      return rewritten;
    },
  };

  return [...deletePhases, claimPhase, migrationPhase];
}

/**
 * Every command fails with a fixed message and no cause: the Upstash client
 * puts the command, with its keys and values, in the error text. A RENAMENX
 * whose source expired meanwhile counts as done.
 */
function withoutCommandDetails(redis: CleanupRedis): CleanupRedis {
  const guard =
    <A extends unknown[], R>(command: (...args: A) => Promise<R>) =>
    async (...args: A) => {
      try {
        return await command(...args);
      } catch {
        throw new Error(REDIS_FAILURE);
      }
    };

  return {
    scan: guard((cursor, options) => redis.scan(cursor, options)),
    get: guard((key) => redis.get(key)),
    mget: guard((...keys) => redis.mget(...keys)),
    set: guard((key, value) => redis.set(key, value)),
    unlink: guard((...keys) => redis.unlink(...keys)),
    renamenx: guard(async (source, destination) => {
      try {
        return await redis.renamenx(source, destination);
      } catch (error) {
        if (/no such key/i.test(String((error as Error)?.message))) return 1;
        throw error;
      }
    }),
  };
}

function globToRegExp(glob: string) {
  const source = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join("[\\s\\S]*");
  return new RegExp(`^${source}$`);
}

/** A handled or retry-later claim; a live lock token is left alone. */
function isSettledClaim(value: unknown) {
  return (
    value === "processed" ||
    (typeof value === "string" && value.startsWith("retry:"))
  );
}

/** `processing-message:{address}:{messageId}` with the address hashed. */
export function hashedClaimKey(key: string) {
  const prefix = "processing-message:";
  const separator = key.lastIndexOf(":");
  if (!key.startsWith(prefix) || separator <= prefix.length) return null;
  const address = key.slice(prefix.length, separator);
  const messageId = key.slice(separator + 1);
  if (!address.includes("@") || !messageId) return null;
  return `${prefix}${hashAddressForKey(address)}:${messageId}`;
}
