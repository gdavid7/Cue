/**
 * What the server no longer keeps (RD-3) kept in this browser instead: briefs,
 * suggested replies, inbox insights and contact photos are asked for once and
 * then read from here, like the local mail store already holds the mail they
 * come from. Each cache is kept per signed-in user and account in
 * localStorage, its entries expire, it is capped in size, and everything is
 * cleared on sign-out and when an account is removed. Full or blocked storage
 * only costs asking the server again.
 */
const PREFIX = "cue:browser-cache:v2:";
// Stores from before entries were scoped to the signed-in user.
const STALE_PREFIXES = ["cue:browser-cache:v1:"];

type Stored<T> = Record<string, { savedAt: number; value: T }>;

// Nothing is read or kept until the signed-in user is known.
let currentUserId: string | null = null;
// Set on sign-out, so a load landing on the way out can't save again.
let blocked = false;
const blockedAccountIds = new Set<string>();

/**
 * Who is signed in. Another user's entries are dropped (one user's at a time
 * on a shared device), and a sign-out's block lifts for the new session.
 */
export function setBrowserCacheUser(userId: string | null | undefined) {
  if (!userId || userId === currentUserId) return;
  currentUserId = userId;
  blocked = false;
  blockedAccountIds.clear();
  for (const key of cacheKeys())
    if (!key.startsWith(`${PREFIX}${userId}:`)) remove(key);
}

export function createBrowserCache<T>({
  name,
  ttlMs,
  maxEntries,
  maxBytes = 512 * 1024,
}: {
  name: string;
  ttlMs: number;
  maxEntries: number;
  /** The most this store may take in localStorage, as serialized. */
  maxBytes?: number;
}) {
  const storageKey = (emailAccountId: string) =>
    currentUserId
      ? `${PREFIX}${currentUserId}:${name}:${emailAccountId}`
      : null;

  return {
    get(emailAccountId: string, key: string, now = Date.now()): T | undefined {
      const storeKey = storageKey(emailAccountId);
      if (!storeKey) return;
      const entry = read<T>(storeKey)[key];
      if (!entry || now - entry.savedAt >= ttlMs) return;
      return entry.value;
    },
    set(emailAccountId: string, key: string, value: T, now = Date.now()) {
      const storeKey = storageKey(emailAccountId);
      if (!storeKey || blocked || blockedAccountIds.has(emailAccountId)) return;
      // Read afresh, so another tab's entries are kept, not overwritten.
      const entries = Object.entries(read<T>(storeKey)).filter(
        ([existing, entry]) => existing !== key && now - entry.savedAt < ttlMs,
      );
      entries.push([key, { savedAt: now, value }]);
      entries.sort(([, a], [, b]) => a.savedAt - b.savedAt);
      write(storeKey, entries.slice(-maxEntries), maxBytes);
    },
  };
}

export function clearBrowserCaches() {
  blocked = true;
  // So whoever signs in next, the same user included, lifts the block.
  currentUserId = null;
  for (const key of cacheKeys()) remove(key);
}

export function clearBrowserCachesForAccount(emailAccountId: string) {
  blockedAccountIds.add(emailAccountId);
  for (const key of cacheKeys())
    if (key.endsWith(`:${emailAccountId}`)) remove(key);
}

export function resetBrowserCacheForTesting(userId: string | null = "user-1") {
  currentUserId = null;
  blocked = false;
  blockedAccountIds.clear();
  setBrowserCacheUser(userId);
}

function read<T>(key: string): Stored<T> {
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(key);
    const stored: unknown = raw ? JSON.parse(raw) : {};
    return stored && typeof stored === "object" ? (stored as Stored<T>) : {};
  } catch {
    return {};
  }
}

/** Newest entries last; the oldest go first when the store is too big or full. */
function write<T>(
  key: string,
  entries: [string, Stored<T>[string]][],
  maxBytes: number,
) {
  if (typeof window === "undefined") return;
  let kept = entries;
  let serialized = JSON.stringify(Object.fromEntries(kept));
  while (kept.length > 1 && serialized.length > maxBytes) {
    kept = kept.slice(Math.ceil(kept.length / 4));
    serialized = JSON.stringify(Object.fromEntries(kept));
  }
  if (serialized.length > maxBytes) return remove(key);
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      window.localStorage.setItem(key, serialized);
      return;
    } catch {
      // Full storage: give up the older half and try again.
      if (kept.length <= 1) break;
      kept = kept.slice(Math.ceil(kept.length / 2));
      serialized = JSON.stringify(Object.fromEntries(kept));
    }
  }
  remove(key);
}

function remove(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Ignore storage failures on the way out.
  }
}

function cacheKeys() {
  const keys: string[] = [];
  try {
    if (typeof window === "undefined") return keys;
    for (let index = 0; index < window.localStorage.length; index++) {
      const key = window.localStorage.key(index);
      if (
        key &&
        (key.startsWith(PREFIX) ||
          STALE_PREFIXES.some((prefix) => key.startsWith(prefix)))
      )
        keys.push(key);
    }
  } catch {
    // Blocked storage holds nothing to clear.
  }
  return keys;
}
