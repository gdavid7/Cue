import type { MailVersionResponse } from "@/app/api/mail-version/route";
import { mailStreamLockName } from "@/utils/mail-engine/follow-mailbox-changes";

// Matches the engine's old idle catch-up, so a hidden tab hears of new mail
// (and can notify) as soon as it did before, at a fraction of the cost.
const POLL_MS = 60_000;
// The route's limit.
const MAX_POLLED_ACCOUNTS = 20;
const POLL_LOCK = "cue:mail-version-poll";
// Shared with the tab that polls next, so a handover misses no change.
const SEEN_STORAGE_KEY = "cue:mail-versions-seen";

type PollLocks = Pick<LockManager, "request" | "query">;
type VersionAnswer =
  | { status: "unchanged" }
  | {
      status: "changed";
      etag: string | null;
      versions: Record<string, string | null>;
    }
  | { status: "unavailable" };

/**
 * Asks once a minute whether the provider reported changes to accounts no
 * tab in this browser is streaming, and syncs only the accounts that moved.
 * One tab in the browser polls, hidden or not, so new mail still reaches the
 * engine (and its notifications) while every tab is in the background. When
 * the poll itself is unavailable, every unstreamed account syncs instead.
 */
export function pollMailVersions({
  accountIds,
  onChanged,
  locks = typeof navigator === "undefined" ? undefined : navigator.locks,
  fetchVersions = fetchMailVersions,
}: {
  accountIds: string[];
  onChanged: (accountIds: string[]) => void;
  locks?: PollLocks;
  fetchVersions?: (
    accountIds: string[],
    etag: string | null,
  ) => Promise<VersionAnswer>;
}) {
  const polled = accountIds.slice(0, MAX_POLLED_ACCOUNTS);
  let stopped = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let release: (() => void) | undefined;
  const abort = new AbortController();
  // Used when storage is unavailable, so the baseline lasts while this tab
  // polls.
  let ownSeen: Seen = { key: null, etag: null, versions: {} };

  const tick = async () => {
    const streamed = await streamedAccounts(locks);
    const due = polled.filter((id) => !streamed(id));
    if (stopped || due.length === 0) return;
    const seen = readStoredSeen() ?? ownSeen;
    const key = due.join(",");
    let answer: VersionAnswer;
    try {
      answer = await fetchVersions(due, seen.key === key ? seen.etag : null);
    } catch {
      answer = { status: "unavailable" };
    }
    if (stopped || answer.status === "unchanged") return;
    if (answer.status === "unavailable") {
      onChanged(due);
      return;
    }
    // An account first seen here sets its baseline; the engine syncs it
    // when it starts anyway.
    const moved = due.filter(
      (id) =>
        id in answer.versions &&
        id in seen.versions &&
        answer.versions[id] !== seen.versions[id],
    );
    ownSeen = {
      key,
      etag: answer.etag,
      versions: { ...seen.versions, ...answer.versions },
    };
    storeSeen(ownSeen);
    if (moved.length > 0) onChanged(moved);
  };

  const run = () => {
    interval = setInterval(() => {
      tick().catch(() => undefined);
    }, POLL_MS);
  };

  if (polled.length > 0) {
    if (locks) {
      locks
        .request(POLL_LOCK, { signal: abort.signal }, () => {
          if (stopped) return;
          run();
          return new Promise<void>((resolve) => {
            release = resolve;
          });
        })
        .catch(() => {
          // Stopped while another tab polled.
        });
    } else {
      run();
    }
  }

  return () => {
    stopped = true;
    clearInterval(interval);
    abort.abort();
    release?.();
  };
}

async function streamedAccounts(locks: PollLocks | undefined) {
  const { held = [] } = (await locks?.query()) ?? {};
  const names = new Set(held.map((lock) => lock.name));
  return (accountId: string) => names.has(mailStreamLockName(accountId));
}

async function fetchMailVersions(
  accountIds: string[],
  etag: string | null,
): Promise<VersionAnswer> {
  const response = await fetch(
    `/api/mail-version?emailAccountIds=${accountIds.map(encodeURIComponent).join(",")}`,
    {
      // The ETag is sent by hand, so the HTTP cache must not answer for it.
      cache: "no-store",
      headers: etag ? { "If-None-Match": etag } : undefined,
    },
  );
  if (response.status === 304) return { status: "unchanged" };
  if (!response.ok) return { status: "unavailable" };
  const body = (await response.json()) as MailVersionResponse;
  return {
    status: "changed",
    etag: response.headers.get("etag"),
    versions: body.versions,
  };
}

type Seen = {
  key: string | null;
  etag: string | null;
  versions: Record<string, string | null>;
};

function readStoredSeen(): Seen | null {
  try {
    const stored = JSON.parse(localStorage.getItem(SEEN_STORAGE_KEY) ?? "null");
    if (stored && typeof stored === "object" && stored.versions) return stored;
  } catch {
    // The tab's own baseline stands in.
  }
  return null;
}

function storeSeen(seen: Seen) {
  try {
    localStorage.setItem(SEEN_STORAGE_KEY, JSON.stringify(seen));
  } catch {
    // The tab keeps its baseline in memory.
  }
}
