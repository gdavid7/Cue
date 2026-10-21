import groupBy from "lodash/groupBy";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useSyncExternalStore,
} from "react";
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
   * The item's row in the list on screen, as `setVisibleRows` counts rows,
   * when some rows have no item; otherwise its place among the items.
   */
  index?: number;
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
type Wanted = {
  threadId: string;
  messageId: string;
  pair: string;
  /** The row's place in its reader's list, for asking about what's on screen first. */
  index: number;
};
/** Rows `start` (inclusive) to `end` (exclusive) of a reader's list are on screen. */
export type VisibleRows = { start: number; end: number };
type ListVersion = { version: number; keys: string[] };
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
  /** Asked to read the kept rows' drafted replies again (refreshInboxInsights). */
  refresh: boolean;
  error: unknown;
};

const queues = new Map<string, Queue>();
// What each reader has on screen. Read when a request is built, so a scroll
// reorders what is asked next without re-rendering the list.
// A range is kept with the list it was measured on, and only applies while
// that list hasn't been replaced (a mailbox switch, a reorder).
const visibleByReader = new Map<
  string,
  { rows: VisibleRows; list: ListVersion; measuredOn: number }
>();
const attempts = new Map<string, number>();
const meta = new Map<
  string,
  Pick<GetInboxInsightsResponse, "events" | "draftRepliesEnabled">
>();
// The messages Cue wrote a reply for ahead of time, waiting in Cue, by
// account, as the server last said for each (DR-3).
const drafted = new Map<string, Set<string>>();
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
 * nothing is asked for. Items are in screen order; with `setVisibleRows`
 * the rows on screen and the screenful after them are asked for first, and
 * the rest after, nearest first.
 */
export function useInboxInsights(
  items: InboxInsightItem[],
  { enabled = true }: { enabled?: boolean } = {},
) {
  const { fetcher } = useSWRConfig();
  const readerId = useId();
  const requests = useMemo(() => getInboxInsightRequests(items), [items]);
  // Rows added below keep the range; any other change replaces the list.
  const list = useRef<ListVersion>({ version: 0, keys: [] });
  const keys = items.map((item) => item.key);
  if (!startsWith(keys, list.current.keys)) list.current.version += 1;
  list.current.keys = keys;
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

  useEffect(
    () => () => {
      visibleByReader.delete(readerId);
    },
    [readerId],
  );
  const setVisibleRows = useCallback(
    (rows: VisibleRows) => {
      visibleByReader.set(readerId, {
        rows,
        list: list.current,
        measuredOn: list.current.version,
      });
    },
    [readerId],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: the queues and caches change with storeVersion
  return useMemo(() => {
    if (!enabled)
      return {
        data: undefined,
        error: undefined,
        isLoading: false,
        setVisibleRows,
      };
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
      const replyDrafted = Boolean(
        drafted.get(item.emailAccountId)?.has(item.messageId),
      );
      if (entry || replyDrafted) {
        data[item.key] = toThreadInsight({
          entry,
          item,
          emailAccountId: item.emailAccountId,
          accountMeta: meta.get(item.emailAccountId),
          replyDrafted,
        });
      }
      if (entry) continue;
      if ((attempts.get(attemptKey(item)) ?? 0) < MAX_ATTEMPTS)
        isLoading = true;
    }
    const failing = [...errors.values()];
    const error = failing.every(Boolean) ? failing[0] : undefined;
    return { data, error, isLoading, setVisibleRows };
  }, [items, enabled, storeVersion, setVisibleRows]);
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

/**
 * One request per account, lane and page of rows, each in screen order so the
 * rows on screen can be asked for first.
 */
export function getInboxInsightRequests(items: InboxInsightItem[]) {
  const byAccount = groupBy(
    items.map((item, index) => ({ ...item, index: item.index ?? index })),
    (item) => `${item.open ? "open" : "rows"}\u0000${item.emailAccountId}`,
  );
  return Object.keys(byAccount)
    .sort()
    .flatMap((group) => {
      const [lane, emailAccountId] = group.split("\u0000") as [Lane, string];
      const unique = new Map<string, Wanted & { key: string }>();
      for (const item of byAccount[group]) {
        if (unique.has(item.key)) continue;
        unique.set(item.key, {
          key: item.key,
          threadId: item.threadId,
          messageId: item.messageId,
          pair: `${encodeURIComponent(item.threadId)}:${encodeURIComponent(item.messageId)}`,
          index: item.index,
        });
      }
      return chunk([...unique.values()], CHUNK_SIZE).map((chunkItems) => ({
        emailAccountId,
        lane,
        items: chunkItems,
      }));
    });
}

/**
 * Reads the account's rows again for what changed on the server rather than
 * in the email, such as a reply Cue drafted being dismissed (which
 * `withoutDraftFor` drops at once). One request for the rows the page
 * already read, which costs no Gmail reads, on the queue's usual spacing and
 * retry times.
 */
export function refreshInboxInsights(
  emailAccountId: string,
  { withoutDraftFor }: { withoutDraftFor?: string } = {},
) {
  if (withoutDraftFor) drafted.get(emailAccountId)?.delete(withoutDraftFor);
  for (const lane of ["rows", "open"] as const) {
    const queue = queues.get(queueKey(emailAccountId, lane));
    if (!queue) continue;
    queue.refresh = true;
    pump(queue);
  }
  notify();
}

/** Part of signing out: nothing read for this user stays on the page. */
export function clearInboxInsightRequests() {
  resetInboxInsightRequestsForTesting();
}

export function resetInboxInsightRequestsForTesting() {
  for (const queue of queues.values()) {
    if (queue.timer) clearTimeout(queue.timer);
  }
  queues.clear();
  visibleByReader.clear();
  attempts.clear();
  answered.clear();
  meta.clear();
  drafted.clear();
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
  const wanted = byScreenPriority(queue.readers);
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
  const needsRefresh = !pending.length && kept.length > 0 && queue.refresh;
  if (!pending.length && !needsMeta && !needsRefresh) return;
  if (needsMeta) queue.metaAttempts += 1;
  queue.refresh = false;
  const batch = pending.length
    ? pending.slice(
        0,
        firstRequestSize(
          pending.length,
          pending.filter((item) => item.onScreen).length,
        ),
      )
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
      const accountDrafted = drafted.get(emailAccountId) ?? new Set<string>();
      const draftedNow = new Set(response.draftedMessageIds ?? []);
      for (const item of batch) {
        if (draftedNow.has(item.messageId)) accountDrafted.add(item.messageId);
        else accountDrafted.delete(item.messageId);
      }
      drafted.set(emailAccountId, accountDrafted);
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
    refresh: false,
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

/**
 * One row's insight: what the email asks, the meeting with its people, and
 * its reply: the one Cue wrote ahead of time, which the reader opens first,
 * or else the one this browser kept.
 */
function toThreadInsight({
  entry,
  item,
  emailAccountId,
  accountMeta,
  replyDrafted,
}: {
  entry: InboxInsightExtraction | undefined;
  item: { threadId: string; messageId: string };
  emailAccountId: string;
  accountMeta:
    | Pick<GetInboxInsightsResponse, "events" | "draftRepliesEnabled">
    | undefined;
  replyDrafted: boolean;
}): ThreadInsightData {
  const suggestion = accountMeta?.draftRepliesEnabled
    ? keptSuggestionFor({
        emailAccountId,
        threadId: item.threadId,
        messageId: item.messageId,
      })
    : null;
  let reply: ThreadInsightData["reply"] = null;
  if (replyDrafted) reply = "drafted";
  else if (suggestion?.status === "suggested") reply = "ready";
  else if (suggestion?.status === "insufficient") reply = "needs-info";
  return {
    insight: entry?.insight ?? null,
    meeting: entry
      ? nextMeetingWith(entry.people, accountMeta?.events ?? [])
      : null,
    reply,
  };
}

/**
 * Every reader's rows, once each: those on screen and the screenful after
 * them first, in screen order, then the rest by how far they are from it.
 */
function byScreenPriority(readers: Queue["readers"]) {
  const ranked = new Map<
    string,
    Wanted & { rank: number; onScreen: boolean }
  >();
  for (const [readerId, items] of readers) {
    const measured = visibleByReader.get(readerId);
    const visible =
      measured && measured.measuredOn === measured.list.version
        ? measured.rows
        : undefined;
    for (const item of items) {
      const placed = placeOnScreen(item.index, visible);
      const existing = ranked.get(item.pair);
      if (!existing || placed.rank < existing.rank)
        ranked.set(item.pair, { ...item, ...placed });
    }
  }
  return [...ranked.values()].sort((a, b) => a.rank - b.rank);
}

function placeOnScreen(index: number, visible: VisibleRows | undefined) {
  if (!visible || visible.end <= visible.start)
    return { rank: index, onScreen: false };
  const end = visible.end + (visible.end - visible.start);
  if (index >= visible.start && index < end)
    return { rank: index - visible.start, onScreen: true };
  const distance = index < visible.start ? visible.start - index : index - end;
  return { rank: end - visible.start + distance, onScreen: false };
}

/**
 * The rows on screen go in a request of their own size when that costs no
 * extra request: each request also reads the account's calendar and counts
 * against its rate limit, so the page still takes as many requests as it
 * did in pages of MAX_NEW_PER_REQUEST.
 */
function firstRequestSize(pendingCount: number, onScreenCount: number) {
  if (!onScreenCount) return MAX_NEW_PER_REQUEST;
  const requests = Math.ceil(pendingCount / MAX_NEW_PER_REQUEST);
  const smallestWithoutExtraRequest =
    pendingCount - MAX_NEW_PER_REQUEST * (requests - 1);
  return Math.min(
    MAX_NEW_PER_REQUEST,
    Math.max(onScreenCount, smallestWithoutExtraRequest),
  );
}

function startsWith(keys: string[], prefix: string[]) {
  return prefix.every((key, index) => keys[index] === key);
}

function chunk<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size)
    chunks.push(items.slice(i, i + size));
  return chunks;
}
