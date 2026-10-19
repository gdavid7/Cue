import groupBy from "lodash/groupBy";
import { useEffect, useId, useMemo, useSyncExternalStore } from "react";
import { useSWRConfig } from "swr";
import type { GetInboxInsightsResponse } from "@/app/api/user/inbox-insights/route";
import { createBrowserCache } from "@/utils/browser-cache";
import type {
  InboxInsightExtraction,
  ThreadInsightData,
} from "@/utils/inbox-insights/get-inbox-insights";
import { nextMeetingWith } from "@/utils/inbox-insights/meeting-match";
import { afterMailCaughtUp } from "@/utils/mail-engine/first-mail-list";
import { getRetryHint } from "@/utils/swr";
import { keptSuggestionFor } from "@/utils/thread-context/suggested-reply-store";

const CHUNK_SIZE = 50;
// What the server reads in one request; the rest wait for the next one.
const MAX_NEW_PER_REQUEST = 25;
// Each email is asked about at most this many times per page load, so
// deferrals end in a few spaced retries rather than a request per render.
const MAX_ATTEMPTS = 6;
// Between two requests for an account's rows: mail landing during a catch-up
// changes the list every few seconds, and each change is batched into the
// next request rather than starting its own.
const ROW_REQUEST_SPACING_MS = 15_000;
// A failure with no retry time doubles from here; the open conversation's
// note is waited on, so it starts sooner.
const BACKOFF_BASE_MS: Record<Lane, number> = { rows: 5000, open: 1000 };

// What Cue read from each email, kept in this browser for as long as the
// email could still be on screen: the server keeps none of it (RD-3).
const extractions = createBrowserCache<InboxInsightExtraction>({
  name: "inbox-insight",
  ttlMs: 30 * 24 * 60 * 60 * 1000,
  maxEntries: 500,
});
// Read without AI access: only who is on the email. Kept a day, like the
// server once did, so each render doesn't read every message from the
// provider again; once the account has AI, the next day asks again.
const extractionsWithoutAi = createBrowserCache<InboxInsightExtraction>({
  name: "inbox-insight-no-ai",
  ttlMs: 24 * 60 * 60 * 1000,
  maxEntries: 500,
});

// What this page was given, whether or not the browser could keep it: the
// browser's store can refuse a write (no user yet, full, blocked, too big),
// and an answer it dropped must not be asked for again on this page.
const answered = new Map<string, InboxInsightExtraction>();

type InboxInsightItem = {
  /** Where the caller looks the insight up; unique across accounts. */
  key: string;
  emailAccountId: string;
  threadId: string;
  messageId: string;
  /**
   * The conversation on screen: asked for at once, at interactive Gmail
   * priority, rather than with the rows once mail has settled.
   */
  open?: boolean;
};

type AccountFetcher = (
  key: [string, string],
) => Promise<GetInboxInsightsResponse>;
type Lane = "rows" | "open";
type Wanted = { threadId: string; messageId: string; pair: string };
type Queue = {
  emailAccountId: string;
  lane: Lane;
  /** What each mounted reader wants, by reader. */
  readers: Map<string, Wanted[]>;
  fetcher: AccountFetcher | null;
  inflight: boolean;
  nextAtMs: number;
  timer: ReturnType<typeof setTimeout> | null;
  waitingForMail: boolean;
  failures: number;
  /** Requests made only for the account's settings and meetings. */
  metaAttempts: number;
  error: unknown;
};

const queues = new Map<string, Queue>();
const attempts = new Map<string, number>();
const meta = new Map<
  string,
  Pick<GetInboxInsightsResponse, "events" | "draftRepliesEnabled">
>();
const listeners = new Set<() => void>();
let version = 0;
let mailSettled = false;

/**
 * Insights for the rows on screen, keyed by each item's `key`. Each thread is
 * sent with its latest message; what this browser already read from a
 * message is kept here and never asked for again. Each account's rows are
 * asked for in one request once the mail list is up and caught up, then at
 * most every 15 s as new mail lands, each email a few times at most, and a
 * deferral waits out its Retry-After. The open conversation's item is asked
 * for at once. Rows from different accounts are asked for with their own
 * account, as the combined inbox mixes them. While `enabled` is false
 * nothing is asked for.
 */
export function useInboxInsights(
  items: InboxInsightItem[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { fetcher } = useSWRConfig();
  const readerId = useId();
  const requests = useMemo(() => getInboxInsightRequests(items), [items]);
  const wantedKey = enabled
    ? requests
        .map(
          (request) =>
            `${request.lane}:${request.emailAccountId}=${request.items.map((item) => item.pair).join(",")}`,
        )
        .join(";")
    : "";
  const storeVersion = useSyncExternalStore(subscribe, getVersion, getVersion);

  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed by what is wanted
  useEffect(() => {
    if (!enabled || !fetcher) return;
    const touched = requests.map((request) => {
      const queue = queueFor(request.emailAccountId, request.lane);
      queue.fetcher = fetcher as AccountFetcher;
      queue.readers.set(readerId, [
        ...(queue.readers.get(readerId) ?? []),
        ...request.items,
      ]);
      return queue;
    });
    for (const queue of new Set(touched)) pump(queue);
    return () => {
      for (const queue of touched) queue.readers.delete(readerId);
    };
  }, [wantedKey, fetcher, readerId]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: the queues and caches change with storeVersion
  return useMemo(() => {
    if (!enabled)
      return { data: undefined, error: undefined, isLoading: false };
    const data: Record<string, ThreadInsightData> = {};
    let isLoading = false;
    // Like one request for the page: an error only when every account on
    // it is failing, so one busy account in All inboxes isn't an error.
    const errors = new Map<string, unknown>();
    for (const item of items) {
      const queueError = queues.get(
        queueKey(item.emailAccountId, item.open ? "open" : "rows"),
      )?.error;
      if (!errors.has(item.emailAccountId) || !queueError)
        errors.set(item.emailAccountId, queueError);
      const entry = keptExtraction(item.emailAccountId, item.messageId);
      if (entry) {
        data[item.key] = toThreadInsight({
          entry,
          item,
          emailAccountId: item.emailAccountId,
          accountMeta: meta.get(item.emailAccountId),
        });
        continue;
      }
      if ((attempts.get(attemptKey(item)) ?? 0) < MAX_ATTEMPTS)
        isLoading = true;
    }
    const failing = [...errors.values()];
    const error = failing.every(Boolean) ? failing[0] : undefined;
    return { data, error, isLoading };
  }, [items, enabled, storeVersion]);
}

/**
 * The open thread's insight, as the reader's features ask for it. They share
 * this shape so they share one request.
 */
export function threadInsightItem({
  emailAccountId,
  threadId,
  messageId,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
}): InboxInsightItem {
  return { key: threadId, emailAccountId, threadId, messageId, open: true };
}

/** One request per account, lane and page of rows, ordered so it is stable. */
export function getInboxInsightRequests(items: InboxInsightItem[]) {
  const byAccount = groupBy(
    items,
    (item) => `${item.open ? "open" : "rows"}\u0000${item.emailAccountId}`,
  );
  return Object.keys(byAccount)
    .sort()
    .flatMap((group) => {
      const [lane, emailAccountId] = group.split("\u0000") as [Lane, string];
      const unique = new Map(
        byAccount[group].map((item) => [
          item.key,
          {
            key: item.key,
            threadId: item.threadId,
            messageId: item.messageId,
            pair: `${encodeURIComponent(item.threadId)}:${encodeURIComponent(item.messageId)}`,
          },
        ]),
      );
      const sorted = [...unique.values()].sort((a, b) =>
        a.pair.localeCompare(b.pair),
      );
      return chunk(sorted, CHUNK_SIZE).map((chunkItems) => ({
        emailAccountId,
        lane,
        items: chunkItems,
      }));
    });
}

export function resetInboxInsightRequestsForTesting() {
  for (const queue of queues.values()) {
    if (queue.timer) clearTimeout(queue.timer);
  }
  queues.clear();
  attempts.clear();
  answered.clear();
  meta.clear();
  mailSettled = false;
}

function pump(queue: Queue) {
  if (queue.inflight || queue.timer) return;
  const waitMs = queue.nextAtMs - Date.now();
  if (waitMs > 0) {
    queue.timer = setTimeout(() => {
      queue.timer = null;
      pump(queue);
    }, waitMs);
    return;
  }
  // The rows never compete with the first mail list or the catch-up behind it.
  if (queue.lane === "rows" && !mailSettled) {
    if (queue.waitingForMail) return;
    queue.waitingForMail = true;
    afterMailCaughtUp(() => {
      mailSettled = true;
      queue.waitingForMail = false;
      pump(queue);
    });
    return;
  }
  const { emailAccountId, fetcher } = queue;
  if (!fetcher) return;
  const wanted = [
    ...new Map(
      [...queue.readers.values()].flat().map((item) => [item.pair, item]),
    ).values(),
  ];
  const pending = wanted.filter(
    (item) =>
      !keptExtraction(emailAccountId, item.messageId) &&
      (attempts.get(attemptKey({ emailAccountId, ...item })) ?? 0) <
        MAX_ATTEMPTS,
  );
  const kept = wanted.filter((item) =>
    keptExtraction(emailAccountId, item.messageId),
  );
  // Every email kept from an earlier page: only the account's settings and
  // meetings are asked for, and as boundedly as the emails.
  const needsMeta =
    !pending.length &&
    kept.length > 0 &&
    !meta.has(emailAccountId) &&
    queue.metaAttempts < MAX_ATTEMPTS;
  if (!pending.length && !needsMeta) return;
  if (needsMeta) queue.metaAttempts += 1;
  const batch = pending.length
    ? pending.slice(0, MAX_NEW_PER_REQUEST)
    : kept.slice(0, CHUNK_SIZE);
  // Only the meeting list and settings are wanted when every email is kept;
  // naming them spares the server reading them.
  const known = batch.filter((item) =>
    keptExtraction(emailAccountId, item.messageId),
  );
  const keptPeople = kept.some(
    (item) => keptExtraction(emailAccountId, item.messageId)?.people.length,
  );
  const params = [
    queue.lane === "open" ? "open=1" : "",
    `items=${batch.map((item) => item.pair).join(",")}`,
    known.length
      ? `known=${known.map((item) => encodeURIComponent(item.messageId)).join(",")}`
      : "",
    keptPeople ? "events=1" : "",
  ].filter(Boolean);
  // Every email sent counts as a try, whatever comes back, so a request
  // can't repeat for an answer that wasn't kept.
  for (const item of batch) {
    if (!known.includes(item)) countAttempt({ emailAccountId, ...item });
  }
  queue.inflight = true;
  notify();
  fetcher([`/api/user/inbox-insights?${params.join("&")}`, emailAccountId])
    .then((response) => {
      meta.set(emailAccountId, {
        events: response.events,
        draftRepliesEnabled: response.draftRepliesEnabled,
      });
      for (const item of batch) {
        const fresh = response.insights[item.threadId];
        if (fresh?.messageId === item.messageId) {
          answered.set(attemptKey({ emailAccountId, ...item }), fresh);
          (fresh.withAi ? extractions : extractionsWithoutAi).set(
            emailAccountId,
            item.messageId,
            fresh,
          );
        }
      }
      queue.failures = 0;
      queue.error = undefined;
      queue.nextAtMs =
        Date.now() + (queue.lane === "rows" ? ROW_REQUEST_SPACING_MS : 0);
    })
    .catch((error: unknown) => {
      queue.failures += 1;
      queue.error = error;
      const status = (error as { status?: number } | null)?.status;
      // A rate limit is asked about once more, after its window.
      if (status === 429) {
        for (const item of batch) {
          const key = attemptKey({ emailAccountId, ...item });
          attempts.set(key, Math.max(MAX_ATTEMPTS - 1, attempts.get(key) ?? 0));
        }
      }
      const hint = getRetryHint(
        error as { status?: number; retryAfterMs?: number },
        queue.failures,
      );
      queue.nextAtMs =
        Date.now() +
        (hint.kind === "wait"
          ? hint.ms
          : BACKOFF_BASE_MS[queue.lane] * 2 ** (queue.failures - 1));
      // A signed-out session asks for nothing more.
      if (hint.kind === "stop") {
        for (const item of batch)
          countAttempt({ emailAccountId, ...item }, MAX_ATTEMPTS);
      }
    })
    .finally(() => {
      queue.inflight = false;
      notify();
      pump(queue);
    });
}

function queueFor(emailAccountId: string, lane: Lane) {
  const key = queueKey(emailAccountId, lane);
  const existing = queues.get(key);
  if (existing) return existing;
  const created: Queue = {
    emailAccountId,
    lane,
    readers: new Map(),
    fetcher: null,
    inflight: false,
    nextAtMs: 0,
    timer: null,
    waitingForMail: false,
    failures: 0,
    metaAttempts: 0,
    error: undefined,
  };
  queues.set(key, created);
  return created;
}

function queueKey(emailAccountId: string, lane: Lane) {
  return `${lane}:${emailAccountId}`;
}

function attemptKey(item: { emailAccountId: string; messageId: string }) {
  return `${item.emailAccountId}:${item.messageId}`;
}

function countAttempt(
  item: { emailAccountId: string; messageId: string },
  to?: number,
) {
  const key = attemptKey(item);
  attempts.set(key, to ?? (attempts.get(key) ?? 0) + 1);
}

function keptExtraction(emailAccountId: string, messageId: string) {
  return (
    extractions.get(emailAccountId, messageId) ??
    extractionsWithoutAi.get(emailAccountId, messageId) ??
    answered.get(attemptKey({ emailAccountId, messageId }))
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getVersion() {
  return version;
}

function notify() {
  version += 1;
  for (const listener of listeners) listener();
}

/** One row's insight: what the email asks, the meeting with its people, and the reply this browser kept. */
function toThreadInsight({
  entry,
  item,
  emailAccountId,
  accountMeta,
}: {
  entry: InboxInsightExtraction;
  item: { threadId: string; messageId: string };
  emailAccountId: string;
  accountMeta:
    | Pick<GetInboxInsightsResponse, "events" | "draftRepliesEnabled">
    | undefined;
}): ThreadInsightData {
  const suggestion = accountMeta?.draftRepliesEnabled
    ? keptSuggestionFor({
        emailAccountId,
        threadId: item.threadId,
        messageId: item.messageId,
      })
    : null;
  let reply: ThreadInsightData["reply"] = null;
  if (suggestion?.status === "suggested") reply = "ready";
  else if (suggestion?.status === "insufficient") reply = "needs-info";
  return {
    insight: entry.insight,
    meeting: nextMeetingWith(entry.people, accountMeta?.events ?? []),
    reply,
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}
