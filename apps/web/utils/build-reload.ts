import { createClientLogger } from "@/utils/logger-client";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import { isMailPath } from "@/utils/mail-url";
import {
  dismissUpdateAvailableToast,
  showUpdateAvailableToast,
} from "@/utils/update-available-toast";

const logger = createClientLogger("build-reload");

const CHANNEL_NAME = "cue:server-build";
// Per tab, so a tab's reloads count against its own cap, and kept across its
// reloads, which is what the cap and the stand-down need.
const RELOAD_LOG_KEY = "cue:build-reload:v2";
// A deploy that is still rolling out, or rolled back, can answer with either
// build for a while; a tab that just reloaded waits this long before another.
const RELOAD_COOLDOWN_MS = 10 * 60_000;
// Builds that keep alternating get this many reloads a day, then none.
const MAX_RELOADS = 3;
const RELOAD_WINDOW_MS = 24 * 60 * 60_000;
// A tab reloads by itself only once it has been out of sight, and untouched,
// this long; anything sooner may be a glance away from half-done work.
const HIDDEN_FOR_MS = 5 * 60_000;
const RECHECK_MS = 30_000;
// A hold that cannot answer, such as a wedged engine, counts as not safe.
const HOLD_TIMEOUT_MS = 5000;
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

type ReloadLog = { at: number[]; from?: string; to?: string };

type BuildReloaderDeps = {
  /** The deployment this page's code came from; none turns reloads off. */
  readOwnBuildId: () => string | undefined;
  /** The desktop app updates through its own release path. */
  isDesktopApp: () => boolean;
  /** This tab's own storage (sessionStorage); none turns reloads off. */
  storage: Pick<Storage, "getItem" | "setItem"> | null;
  reload: () => void;
  isHidden: () => boolean;
  /** The mail list, reader or Today, whose only editable surface is a composer. */
  isMailShellRoute: () => boolean;
  /** Whether the user is typing into a field the reload would clear. */
  isEditingText: () => boolean;
  hasOpenDialog: () => boolean;
  /** A toast with an action, such as an undo window, is still on screen. */
  hasActionToast: () => boolean;
  offerReload: (onReload: () => void) => void;
  withdrawOffer: () => void;
  /** Tells the other tabs; they all run older code than the server too. */
  broadcast?: (buildId: string) => void;
  now?: () => number;
};

export function createBuildReloader(deps: BuildReloaderDeps) {
  const now = deps.now ?? Date.now;
  const holds = new Set<ReloadHold>();
  let target: string | null = null;
  let lastBroadcast: string | null = null;
  let lastActivityAt = now();
  let hiddenSince: number | null = deps.isHidden() ? now() : null;
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking = false;
  let reloading = false;
  // The build a reload last aimed for but did not get, as when the service
  // worker's saved shell answered: this tab waits for a different one.
  let standDownFrom: string | null | undefined;

  function ownBuildId() {
    if (deps.isDesktopApp()) return;
    return deps.readOwnBuildId();
  }

  function noteServerBuild(buildId: string, options?: { fromPeer?: boolean }) {
    const own = ownBuildId();
    if (!own || !buildId || reloading) return;
    if (!options?.fromPeer && buildId !== lastBroadcast) {
      lastBroadcast = buildId;
      deps.broadcast?.(buildId);
    }
    standDownFrom ??= readStandDown(own);
    if (buildId === own) {
      // A rollback, or a rollout that went back, before this tab reloaded.
      becomeCurrent();
      return;
    }
    if (buildId === standDownFrom || buildId === target) return;
    if (!target) {
      timer = setInterval(checkSoon, RECHECK_MS);
      logger.info("Server runs a newer build");
    }
    target = buildId;
    if (!deps.isHidden()) deps.offerReload(reloadNow);
    checkSoon();
  }

  /** Runs when the tab is hidden or shown again. */
  function noteVisibility() {
    if (deps.isHidden()) {
      hiddenSince = now();
      // Its action button would hold the reload it offers.
      if (target) deps.withdrawOffer();
    } else {
      hiddenSince = null;
      if (target && !reloading) deps.offerReload(reloadNow);
    }
    checkSoon();
  }

  /**
   * Runs after an in-app route change. A stale tab goes to its new route by
   * a full load instead, as Next.js does for its own version skew.
   */
  function noteNavigation() {
    if (!target || reloading) return;
    reloadWhen(() => true).catch(() => undefined);
  }

  /** The hidden-tab reload: only a long-unwatched mail screen. */
  async function check() {
    await reloadWhen(
      () =>
        hiddenSince !== null &&
        now() - hiddenSince >= HIDDEN_FOR_MS &&
        now() - lastActivityAt >= HIDDEN_FOR_MS &&
        deps.isMailShellRoute(),
    );
  }

  async function reloadWhen(moment: () => boolean) {
    if (!target || reloading || checking) return;
    if (!moment() || !pageAtRest() || !reloadAllowed()) return;
    checking = true;
    try {
      for (const hold of [...holds]) {
        if (!(await holdAllows(hold))) return;
      }
    } finally {
      checking = false;
    }
    // The holds take a moment, in which the user may have come back.
    if (!target || reloading || !moment() || !pageAtRest()) return;
    if (!recordReload(target)) return;
    reload();
  }

  function pageAtRest() {
    return (
      !deps.isEditingText() && !deps.hasOpenDialog() && !deps.hasActionToast()
    );
  }

  /** The user asked for it, so only the record that stops a loop is needed. */
  function reloadNow() {
    if (!target || reloading) return;
    recordReload(target);
    reload();
  }

  function reload() {
    reloading = true;
    stopRechecking();
    logger.info("Reloading onto the server's build");
    deps.reload();
  }

  function becomeCurrent() {
    if (target) deps.withdrawOffer();
    target = null;
    stopRechecking();
  }

  function checkSoon() {
    check().catch(() => undefined);
  }

  function reloadAllowed() {
    const log = readLog();
    if (!log || log.at.length >= MAX_RELOADS) return false;
    return log.at.every((at) => now() - at >= RELOAD_COOLDOWN_MS);
  }

  function readStandDown(own: string) {
    const log = readLog();
    return log?.from === own && log.to ? log.to : null;
  }

  // Without a record of this tab's reloads nothing could stop a loop, so a
  // tab whose storage fails never reloads by itself.
  function readLog(): ReloadLog | null {
    if (!deps.storage) return null;
    try {
      const parsed = JSON.parse(deps.storage.getItem(RELOAD_LOG_KEY) ?? "{}");
      const at: unknown[] = Array.isArray(parsed?.at) ? parsed.at : [];
      return {
        at: at.filter(
          (value): value is number =>
            typeof value === "number" && now() - value < RELOAD_WINDOW_MS,
        ),
        from: typeof parsed?.from === "string" ? parsed.from : undefined,
        to: typeof parsed?.to === "string" ? parsed.to : undefined,
      };
    } catch {
      return null;
    }
  }

  function recordReload(to: string) {
    const log = readLog();
    if (!deps.storage || !log) return false;
    try {
      deps.storage.setItem(
        RELOAD_LOG_KEY,
        JSON.stringify({
          at: [...log.at, now()].slice(-MAX_RELOADS),
          from: ownBuildId(),
          to,
        } satisfies ReloadLog),
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
    noteVisibility,
    noteNavigation,
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
    dispose: stopRechecking,
  };
}

const reloader =
  typeof window === "undefined" ? null : createPageBuildReloader();

/**
 * Hears the deployment that answered one of this page's mail engine
 * requests. A newer one than this page's code offers the user a reload, and
 * reloads a tab left hidden on a mail screen, which also restarts the engine
 * worker the owning tab runs.
 */
export function noteServerBuild(buildId: string) {
  reloader?.noteServerBuild(buildId);
}

/** For the app's route changes: a stale tab loads its new route in full. */
export function noteBuildReloadNavigation() {
  reloader?.noteNavigation();
}

/**
 * Keeps this tab from reloading onto a new build while the hold is in place,
 * or while canReload resolves false.
 */
export function holdBuildReload(canReload?: ReloadHold) {
  return reloader?.hold(canReload) ?? (() => undefined);
}

export function isMailShellPath(pathname: string) {
  if (isMailPath(pathname)) return true;
  const segments = pathname.split("/").filter(Boolean);
  return segments.length === 2 && segments[1] === "home";
}

export function pageHasOpenDialog(doc: Document) {
  return Boolean(
    doc.querySelector(
      '[role="dialog"][data-state="open"], [aria-modal="true"]',
    ),
  );
}

export function pageHasActionToast(doc: Document) {
  return Boolean(doc.querySelector("[data-sonner-toast] [data-button]"));
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
    isDesktopApp: () => Boolean(getInboxZeroDesktopApp()),
    storage: readSessionStorage(),
    reload: () => window.location.reload(),
    isHidden: () => document.visibilityState === "hidden",
    isMailShellRoute: () => isMailShellPath(window.location.pathname),
    isEditingText,
    hasOpenDialog: () => pageHasOpenDialog(document),
    hasActionToast: () => pageHasActionToast(document),
    offerReload: showUpdateAvailableToast,
    withdrawOffer: dismissUpdateAvailableToast,
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
  for (const type of ACTIVITY_EVENTS) {
    window.addEventListener(type, created.noteActivity, {
      passive: true,
      capture: true,
    });
  }
  document.addEventListener("visibilitychange", created.noteVisibility);
  return created;
}

function holdAllows(hold: ReloadHold) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    Promise.resolve()
      .then(hold)
      .catch(() => false),
    new Promise<boolean>((resolve) => {
      timeout = setTimeout(() => resolve(false), HOLD_TIMEOUT_MS);
    }),
  ]).finally(() => clearTimeout(timeout));
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
