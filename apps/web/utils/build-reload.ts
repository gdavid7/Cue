import { createClientLogger } from "@/utils/logger-client";

const logger = createClientLogger("build-reload");

const CHANNEL_NAME = "cue:server-build";
// Per tab, so a tab's reloads count against its own cap, and kept across its
// reloads, which is what the cap is for.
const RELOAD_LOG_KEY = "cue:build-reload:v1";
// A deploy that is still rolling out, or rolled back, can answer with either
// build for a while; a tab that just reloaded waits this long before another.
const RELOAD_COOLDOWN_MS = 10 * 60_000;
// Builds that keep alternating get this many reloads a day, then none.
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 24 * 60 * 60_000;
// A visible tab reloads only once the user has left it alone this long.
const IDLE_MS = 60_000;
const RECHECK_MS = 30_000;
const ACTIVITY_EVENTS = [
  "pointerdown",
  "pointermove",
  "keydown",
  "wheel",
  "touchstart",
  "scroll",
] as const;

/** Resolves false while reloading would lose or interrupt something. */
type ReloadHold = () => boolean | Promise<boolean>;

type BuildReloaderDeps = {
  /** The deployment this page's code came from; none turns reloads off. */
  readOwnBuildId: () => string | undefined;
  /** This tab's own storage (sessionStorage); none turns reloads off. */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  isHidden: () => boolean;
  /** Whether the user is typing into a field the reload would clear. */
  isEditingText: () => boolean;
  /** Tells the other tabs; they all run older code than the server too. */
  broadcast?: (buildId: string) => void;
  now?: () => number;
};

export function createBuildReloader(deps: BuildReloaderDeps) {
  const now = deps.now ?? Date.now;
  const holds = new Set<ReloadHold>();
  let target: string | null = null;
  let lastBroadcast: string | null = null;
  let lastActivityAt = 0;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let reloading = false;

  function noteServerBuild(buildId: string, options?: { fromPeer?: boolean }) {
    const ownBuildId = deps.readOwnBuildId();
    if (!ownBuildId || !buildId || reloading) return;
    if (!options?.fromPeer && buildId !== lastBroadcast) {
      lastBroadcast = buildId;
      deps.broadcast?.(buildId);
    }
    if (buildId === ownBuildId) {
      // A rollback, or a rollout that went back, before this tab reloaded.
      target = null;
      stopRechecking();
      return;
    }
    if (target === buildId) return;
    if (!target) {
      lastActivityAt = now();
      timer = setInterval(checkSoon, RECHECK_MS);
      logger.info("Server runs a newer build; reloading when safe");
    }
    target = buildId;
    checkSoon();
  }

  async function check() {
    if (!target || reloading || checking) return;
    if (!isQuietMoment() || !reloadAllowed()) return;
    checking = true;
    try {
      for (const hold of [...holds]) {
        if (
          !(await Promise.resolve()
            .then(hold)
            .catch(() => false))
        )
          return;
      }
    } finally {
      checking = false;
    }
    // The holds can take a moment, in which the user may have come back.
    if (!target || reloading || !isQuietMoment()) return;
    if (!recordReload()) return;
    reloading = true;
    stopRechecking();
    logger.info("Reloading onto the server's build");
    deps.reload();
  }

  function checkSoon() {
    check().catch(() => undefined);
  }

  function isQuietMoment() {
    if (deps.isEditingText()) return false;
    return deps.isHidden() || now() - lastActivityAt >= IDLE_MS;
  }

  function reloadAllowed() {
    const recent = readRecentReloads();
    if (!recent || recent.length >= MAX_RELOADS) return false;
    return recent.every((at) => now() - at >= RELOAD_COOLDOWN_MS);
  }

  // Without a record of this tab's reloads nothing could stop a loop, so a
  // tab whose storage fails never reloads.
  function readRecentReloads(): number[] | null {
    if (!deps.storage) return null;
    try {
      const parsed: unknown = JSON.parse(
        deps.storage.getItem(RELOAD_LOG_KEY) ?? "[]",
      );
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(
        (at): at is number =>
          typeof at === "number" && now() - at < RELOAD_WINDOW_MS,
      );
    } catch {
      return null;
    }
  }

  function recordReload() {
    const recent = readRecentReloads();
    if (!deps.storage || !recent) return false;
    try {
      deps.storage.setItem(
        RELOAD_LOG_KEY,
        JSON.stringify([...recent, now()].slice(-MAX_RELOADS)),
      );
      return true;
    } catch {
      return false;
    }
  }

  function stopRechecking() {
    clearInterval(timer);
    timer = undefined;
  }

  return {
    noteServerBuild,
    check,
    checkSoon,
    /** Keeps this tab from reloading until the returned release runs. */
    hold(canReload: ReloadHold = () => false) {
      holds.add(canReload);
      return () => {
        holds.delete(canReload);
        checkSoon();
      };
    },
    noteActivity() {
      lastActivityAt = now();
    },
    get stale() {
      return target !== null;
    },
    dispose: stopRechecking,
  };
}

const reloader =
  typeof window === "undefined" ? null : createPageBuildReloader();

/**
 * Hears the deployment that answered one of this page's mail engine
 * requests. A newer one than this page's code reloads every tab of Cue at a
 * safe moment, which also restarts the engine worker the owning tab runs.
 */
export function noteServerBuild(buildId: string) {
  reloader?.noteServerBuild(buildId);
}

/**
 * Keeps this tab from reloading onto a new build while the hold is in place,
 * or while canReload resolves false.
 */
export function holdBuildReload(canReload?: ReloadHold) {
  return reloader?.hold(canReload) ?? (() => undefined);
}

function createPageBuildReloader() {
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CHANNEL_NAME);
  const created = createBuildReloader({
    // Next.js sets this from its deployment id (data-dpl-id), the same value
    // the server names in each mail engine response. Read when first needed,
    // after Next.js has registered it.
    readOwnBuildId: () => process.env.NEXT_DEPLOYMENT_ID || undefined,
    storage: readSessionStorage(),
    reload: () => window.location.reload(),
    isHidden: () => document.visibilityState === "hidden",
    isEditingText,
    broadcast: (buildId) => {
      try {
        channel?.postMessage({ type: "server_build", buildId });
      } catch {
        // A closed channel only means the other tabs hear it from their own
        // requests or navigations.
      }
    },
  });
  channel?.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (message?.type === "server_build" && typeof message.buildId === "string")
      created.noteServerBuild(message.buildId, { fromPeer: true });
  });
  const onActivity = () => {
    if (created.stale) created.noteActivity();
  };
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, onActivity, { passive: true, capture: true });
  }
  document.addEventListener("visibilitychange", created.checkSoon);
  return created;
}

function readSessionStorage() {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function isEditingText() {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement)) return false;
  if (active.isContentEditable) return true;
  if (active instanceof HTMLTextAreaElement) return active.value.length > 0;
  return (
    active instanceof HTMLInputElement &&
    !["checkbox", "radio", "button", "submit", "reset", "range"].includes(
      active.type,
    ) &&
    active.value.length > 0
  );
}
