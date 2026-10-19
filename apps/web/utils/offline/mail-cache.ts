// `/mail/u/{n}` and every view under it (`/mail/u/0/sent/{threadId}`).
const MAIL_PATH = /^\/mail\/u\/(\d+)(?:\/.*)?$/u;
export const ACCOUNT_PATH = "/api/user/email-accounts";
export const OFFLINE_MAIL_CACHE_PREFIX = "inbox-zero:offline-mail:";
export const MAIL_ENGINE_STATIC_CACHE = "inbox-zero:mail-engine-static";
export const CLEAR_OFFLINE_MAIL = "inbox-zero:clear-offline-mail";
export const CLEAR_OFFLINE_MAIL_ACCOUNT =
  "inbox-zero:clear-offline-mail-account";
export const SAVE_OFFLINE_MAIL = "inbox-zero:save-offline-mail";
export const SKIP_WAITING = "SKIP_WAITING";
/** Marks the worker's own refresh of a saved shell, which needs no inbox rows. */
export const OFFLINE_MAIL_SAVE_HEADER = "x-cue-offline-save";

type WaitUntil = (promise: Promise<unknown>) => void;

// Shell documents and account metadata let the mail route reopen from Cache
// Storage after activation. Mailbox state lives in SQLite; API mutations and
// authentication always use the network.
export function createOfflineMailCache({
  origin,
  cacheName,
}: {
  origin: string;
  cacheName: string;
}) {
  let generation = 0;
  let accountsGeneration = 0;
  let activeClears = 0;
  let writes: Promise<unknown> = Promise.resolve();
  const saves = new Map<string, Promise<void>>();

  function queueWrite(operation: (cache: Cache) => Promise<unknown>) {
    writes = writes
      .then(async () => operation(await caches.open(cacheName)))
      .catch(() => {});
    return writes;
  }

  async function clear() {
    generation++;
    activeClears++;
    saves.clear();
    try {
      await queueWrite(async (cache) => {
        await Promise.all((await cache.keys()).map((key) => cache.delete(key)));
      });
    } finally {
      activeClears--;
    }
  }

  async function handle(request: Request, waitUntil: WaitUntil) {
    const startedAtGeneration = activeClears ? undefined : generation;
    const startedAccountsGeneration = accountsGeneration;
    const url = new URL(request.url);
    const isDocument = isOfflineMailPath(url.pathname);
    // Every view of an account is the same shell, read from the address on
    // the client, so one saved copy per account serves them all.
    const key = `${origin}${isDocument ? offlineMailDocumentPath(url.pathname) : url.pathname}`;
    const controller = new AbortController();
    const abortRequest = () => controller.abort(request.signal.reason);
    request.signal.addEventListener("abort", abortRequest, { once: true });
    if (request.signal.aborted) abortRequest();
    const networkTimeout = setTimeout(() => {
      controller.abort(new Error("Mailbox request timed out"));
    }, 15_000);
    const cached = async () => {
      if (startedAtGeneration !== generation) return;
      try {
        // An in-flight refresh must not block reading the previous saved copy.
        const response = await (await caches.open(cacheName)).match(key);
        return startedAtGeneration === generation ? response : undefined;
      } catch {
        return;
      }
    };
    const network = (async () => {
      const response = await fetch(request, { signal: controller.signal });
      const responsePath = response.url
        ? new URL(response.url).pathname
        : url.pathname;
      if (
        response.status === 401 ||
        response.status === 403 ||
        (isDocument && response.redirected && responsePath !== url.pathname)
      ) {
        if (startedAtGeneration === generation) await clear();
        return response;
      }
      if (response.status >= 500) {
        return (await cached()) ?? response;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (
        response.status === 200 &&
        contentType.includes(isDocument ? "text/html" : "application/json") &&
        startedAtGeneration === generation
      ) {
        // Headers can arrive while the streamed HTML stalls indefinitely, so
        // the timeout holds until the body's first bytes show it is readable.
        // The page then reads the rest as it streams, as it would without
        // this worker: the server streams the inbox's first rows last, and
        // waiting for the whole document would hold back the first paint and
        // every script it loads. The saved copy waits for the whole body.
        const { saved: whole } = await readableCopy(response);
        waitUntil(
          whole
            .then((saved) =>
              queueWrite(async (cache) => {
                // Logout can happen while opening Cache Storage or writing another entry.
                if (
                  startedAtGeneration === generation &&
                  ((!isDocument && key !== `${origin}${ACCOUNT_PATH}`) ||
                    startedAccountsGeneration === accountsGeneration)
                ) {
                  await cache.put(key, saved);
                }
              }),
            )
            // A body that fails after its first bytes is not saved.
            .catch(() => {}),
        );
      }
      return response;
    })().finally(() => {
      clearTimeout(networkTimeout);
      request.signal.removeEventListener("abort", abortRequest);
    });
    // Keep a late successful response alive to refresh the offline copy, even
    // after the timeout has already returned the saved document.
    waitUntil(network.catch(() => {}));
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const fallback = new Promise<Response>((resolve) => {
      timeout = setTimeout(async () => {
        const response = await cached();
        if (response) resolve(response);
      }, 3000);
    });
    try {
      return await Promise.race([
        network.catch(async (error: unknown) => {
          const response = await cached();
          if (response) return response;
          throw error;
        }),
        fallback,
      ]);
    } finally {
      clearTimeout(timeout);
    }
  }

  function save(url: string, waitUntil: WaitUntil): Promise<void> {
    const parsed = new URL(url);
    if (
      activeClears ||
      parsed.origin !== origin ||
      !isOfflineMailPath(parsed.pathname)
    )
      return Promise.resolve();
    const key = offlineMailDocumentPath(parsed.pathname);
    const existing = saves.get(key);
    if (existing) return existing;
    const startedAtGeneration = generation;
    const backgroundWork: Promise<unknown>[] = [];
    const trackWork: WaitUntil = (promise) => {
      backgroundWork.push(promise);
      waitUntil(promise);
    };
    const saving = (async () => {
      const response = await handle(
        new Request(url, {
          credentials: "include",
          headers: { Accept: "text/html", [OFFLINE_MAIL_SAVE_HEADER]: "1" },
        }),
        trackWork,
      );
      if (
        response.status !== 200 ||
        response.redirected ||
        startedAtGeneration !== generation
      )
        return;
      await handle(
        new Request(`${origin}${ACCOUNT_PATH}`, {
          credentials: "include",
        }),
        trackWork,
      );
    })().finally(async () => {
      // A cached fallback can return while the live refresh is still running.
      await Promise.all(backgroundWork);
      await writes;
      if (saves.get(key) === saving) saves.delete(key);
    });
    saves.set(key, saving);
    return saving;
  }

  // Mail is addressed by account position, so removing one account moves the
  // ones after it: every saved mailbox goes, and is saved again on next visit.
  async function removeAccount(accountId: string) {
    if (!isSafeOfflineMailAccountId(accountId)) return;
    accountsGeneration += 1;
    await queueWrite(async (cache) => {
      const keys = (await cache.keys())
        .map((request) => request.url)
        .filter((url) => isOfflineMailAccountKey(url, origin));
      await Promise.all(keys.map((key) => cache.delete(key)));
    });
  }

  return { handle, clear, save, removeAccount };
}

export function matchesOfflineMailRequest(request: Request, origin: string) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return false;
  if (request.headers.has("RSC")) return false;
  return (
    (request.mode === "navigate" && isOfflineMailPath(url.pathname)) ||
    (url.pathname === ACCOUNT_PATH && !url.search)
  );
}

export function matchesMailEngineStaticRequest(
  request: Request,
  origin: string,
) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return false;
  if (url.pathname.includes("hot-update") || url.pathname.endsWith(".map")) {
    return false;
  }
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.endsWith(".wasm") ||
    request.destination === "worker"
  );
}

export function isOfflineMailPath(pathname: string) {
  return MAIL_PATH.test(pathname);
}

export function isSafeOfflineMailAccountId(accountId: string) {
  return (
    accountId.length > 0 &&
    !accountId.includes("/") &&
    !accountId.includes("\\") &&
    !accountId.includes("..")
  );
}

/** The one saved copy that serves every view of an account's mail. */
export function offlineMailDocumentPath(pathname: string) {
  const match = MAIL_PATH.exec(pathname);
  return match ? `/mail/u/${match[1]}` : pathname;
}

/** A saved mailbox or the account list it was saved with. */
export function isOfflineMailAccountKey(key: string, origin: string) {
  const url = new URL(key);
  return (
    url.origin === origin &&
    (isOfflineMailPath(url.pathname) || url.pathname === ACCOUNT_PATH)
  );
}

export function clearsOfflineMailOnGet(request: Request, origin: string) {
  const url = new URL(request.url);
  if (request.method !== "GET" || url.origin !== origin) return false;
  return (
    url.pathname === "/api/sso/signin" ||
    url.pathname.startsWith("/api/auth/sso/") ||
    (request.mode === "navigate" &&
      ["/login", "/welcome-redirect", "/connect-mailbox"].includes(
        url.pathname,
      ))
  );
}

/**
 * Resolves once the response's body has started, with a promise of a complete
 * copy to save; the response itself is left for the page to stream.
 */
async function readableCopy(
  response: Response,
): Promise<{ saved: Promise<Response> }> {
  const copy = response.clone();
  const reader = copy.body?.getReader();
  if (!reader) return { saved: Promise.resolve(copy) };
  const first = await reader.read();
  const rest = (async () => {
    const chunks: Uint8Array[] = first.value ? [first.value] : [];
    for (let next = first; !next.done; ) {
      next = await reader.read();
      if (next.value) chunks.push(next.value);
    }
    return new Response(new Blob(chunks as BlobPart[]), {
      status: copy.status,
      statusText: copy.statusText,
      headers: copy.headers,
    });
  })();
  return { saved: rest };
}
