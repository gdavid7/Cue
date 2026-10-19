import { hashAddressForKey } from "@/utils/redis/address-key";

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
  { match: "thread:*", holds: "Deep Clean threads with sender and subject" },
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
  set(key: string, value: string): Promise<unknown>;
  unlink(...keys: string[]): Promise<number>;
  renamenx(source: string, destination: string): Promise<number>;
};

export async function deletePiiCacheKeys({
  redis,
  dryRun = false,
  log = () => {},
}: {
  redis: CleanupRedis;
  dryRun?: boolean;
  log?: (line: string) => void;
}) {
  const counts: Record<string, number> = {};

  for (const pattern of PII_KEY_PATTERNS) {
    let removed = 0;
    for await (const batch of scanKeys(redis, pattern.match)) {
      const keys = batch.filter((key) => !pattern.keep?.(key));
      if (!keys.length) continue;
      if (!dryRun) await redis.unlink(...keys);
      removed += keys.length;
    }
    counts[pattern.match] = removed;
    log(
      `${dryRun ? "would delete" : "deleted"} ${removed} ${pattern.match} (${pattern.holds})`,
    );
  }

  let renamed = 0;
  for await (const batch of scanKeys(redis, LEGACY_CLAIM_PATTERN)) {
    for (const key of batch) {
      const destination = hashedClaimKey(key);
      if (!destination || !isSettledClaim(await redis.get(key))) continue;
      renamed++;
      if (dryRun) continue;
      // The hashed key wins when both exist: it is the newer claim.
      if (!(await redis.renamenx(key, destination))) await redis.unlink(key);
    }
  }
  counts[LEGACY_CLAIM_PATTERN] = renamed;
  log(
    `${dryRun ? "would rename" : "renamed"} ${renamed} ${LEGACY_CLAIM_PATTERN} to hashed keys`,
  );

  let rewritten = 0;
  for await (const batch of scanKeys(redis, WEEKLY_MIGRATION_PATTERN)) {
    for (const key of batch) {
      const byDay = weeklyCostsByDay(await redis.get(key));
      if (!byDay) continue;
      rewritten++;
      if (!dryRun)
        await redis.set(
          key,
          JSON.stringify({ weeklyCostsByDay: Object.fromEntries(byDay) }),
        );
    }
  }
  counts[WEEKLY_MIGRATION_PATTERN] = rewritten;
  log(
    `${dryRun ? "would rewrite" : "rewrote"} ${rewritten} ${WEEKLY_MIGRATION_PATTERN} by day`,
  );

  return counts;
}

/** A handled or retry-later claim; a live lock token is left alone. */
function isSettledClaim(value: unknown) {
  return (
    value === "processed" ||
    (typeof value === "string" && value.startsWith("retry:"))
  );
}

/** An old weekly migration record summed by day, or null if already by day. */
export function weeklyCostsByDay(value: unknown) {
  let state: unknown = value;
  if (typeof value === "string") {
    try {
      state = JSON.parse(value);
    } catch {
      return null;
    }
  }
  const legacy = (state as { weeklyCosts?: Record<string, unknown> } | null)
    ?.weeklyCosts;
  if (!legacy || typeof legacy !== "object") return null;
  const byDay = new Map<string, number>();
  for (const [key, raw] of Object.entries(legacy)) {
    const day = /:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
    const cost = Number(raw);
    if (day && cost > 0) byDay.set(day, (byDay.get(day) ?? 0) + cost);
  }
  return byDay;
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

async function* scanKeys(redis: CleanupRedis, match: string) {
  let cursor: string | number = 0;
  do {
    const [next, keys] = await redis.scan(cursor, { match, count: 500 });
    cursor = next;
    for (let start = 0; start < keys.length; start += 100)
      yield keys.slice(start, start + 100);
  } while (String(cursor) !== "0");
}
