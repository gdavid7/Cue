/**
 * What the server no longer keeps (RD-3) kept in this browser instead: briefs,
 * suggested replies, inbox insights and contact photos are asked for once and
 * then read from here, like the local mail store already holds the mail they
 * come from. Each cache is kept per account in localStorage, its entries
 * expire, and everything is cleared on sign-out and when an account is
 * removed. Full or blocked storage only costs asking the server again.
 */
const PREFIX = "cue:browser-cache:v1:";

type Stored<T> = Record<string, { savedAt: number; value: T }>;

// Set on sign-out, so a load landing on the way out can't save again. Module
// state ends with the page, which is the life the block needs.
let blocked = false;
const blockedAccountIds = new Set<string>();
// Parsed once per page: a page of inbox rows reads a cache many times.
const parsed = new Map<string, Stored<unknown>>();

export function createBrowserCache<T>({
  name,
  ttlMs,
  maxEntries,
}: {
  name: string;
  ttlMs: number;
  maxEntries: number;
}) {
  const storageKey = (emailAccountId: string) =>
    `${PREFIX}${name}:${emailAccountId}`;

  return {
    get(emailAccountId: string, key: string, now = Date.now()): T | undefined {
      const entry = read<T>(storageKey(emailAccountId))[key];
      if (!entry || now - entry.savedAt >= ttlMs) return;
      return entry.value;
    },
    set(emailAccountId: string, key: string, value: T, now = Date.now()) {
      if (blocked || blockedAccountIds.has(emailAccountId)) return;
      const entries = Object.entries(
        read<T>(storageKey(emailAccountId)),
      ).filter(
        ([existing, entry]) => existing !== key && now - entry.savedAt < ttlMs,
      );
      entries.push([key, { savedAt: now, value }]);
      entries.sort(([, a], [, b]) => a.savedAt - b.savedAt);
      write(
        storageKey(emailAccountId),
        Object.fromEntries(entries.slice(-maxEntries)),
      );
    },
  };
}

export function clearBrowserCaches() {
  blocked = true;
  parsed.clear();
  for (const key of cacheKeys()) remove(key);
}

export function clearBrowserCachesForAccount(emailAccountId: string) {
  blockedAccountIds.add(emailAccountId);
  for (const key of parsed.keys())
    if (key.endsWith(`:${emailAccountId}`)) parsed.delete(key);
  for (const key of cacheKeys())
    if (key.endsWith(`:${emailAccountId}`)) remove(key);
}

export function resetBrowserCacheBlocksForTesting() {
  blocked = false;
  blockedAccountIds.clear();
  parsed.clear();
}

function read<T>(key: string): Stored<T> {
  const known = parsed.get(key);
  if (known) return known as Stored<T>;
  let value: Stored<T> = {};
  try {
    if (typeof window === "undefined") return {};
    const raw = window.localStorage.getItem(key);
    const stored: unknown = raw ? JSON.parse(raw) : {};
    if (stored && typeof stored === "object") value = stored as Stored<T>;
  } catch {
    // Unreadable storage holds nothing.
  }
  parsed.set(key, value);
  return value;
}

function write<T>(key: string, value: Stored<T>) {
  parsed.set(key, value);
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Full or blocked storage: the next view asks the server again.
  }
}

function remove(key: string) {
  parsed.delete(key);
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
      if (key?.startsWith(PREFIX)) keys.push(key);
    }
  } catch {
    // Blocked storage holds nothing to clear.
  }
  return keys;
}
