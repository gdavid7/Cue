import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
import {
  dismissUpdateAvailableToast,
  showUpdateAvailableToast,
} from "@/utils/update-available-toast";

const CHANNEL_NAME = "cue:server-build";

type BuildUpdateDeps = {
  /** The deployment this page's code came from; none turns offers off. */
  readOwnBuildId: () => string | undefined;
  /** The desktop app updates through its own release path. */
  isDesktopApp: () => boolean;
  reload: () => void;
  offerReload: (onReload: () => void, onDismiss: () => void) => void;
  withdrawOffer: () => void;
  /** Tells the other tabs; they all run older code than the server too. */
  broadcast?: (buildId: string) => void;
};

export function createBuildUpdateNotifier(deps: BuildUpdateDeps) {
  // Each newer build is offered once per tab; one the user dismissed stays
  // dismissed.
  const offeredBuilds = new Set<string>();
  let offered: string | null = null;
  let lastBroadcast: string | null = null;

  function noteServerBuild(buildId: string, options?: { fromPeer?: boolean }) {
    const ownBuildId = deps.isDesktopApp() ? undefined : deps.readOwnBuildId();
    if (!ownBuildId || !buildId) return;
    if (!options?.fromPeer && buildId !== lastBroadcast) {
      lastBroadcast = buildId;
      deps.broadcast?.(buildId);
    }
    if (buildId === ownBuildId) {
      // A rollback, or a rollout that went back: this page is current again.
      if (offered) {
        offered = null;
        deps.withdrawOffer();
      }
      return;
    }
    if (offeredBuilds.has(buildId)) return;
    offeredBuilds.add(buildId);
    offered = buildId;
    deps.offerReload(deps.reload, () => {
      if (offered === buildId) offered = null;
    });
  }

  return { noteServerBuild };
}

const notifier =
  typeof window === "undefined" ? null : createPageBuildUpdateNotifier();

/**
 * Hears the deployment that answered one of this page's mail engine
 * requests. A newer one than this page's code offers the user a reload in
 * every tab; reloading the tab that owns the engine restarts its worker on
 * the new code.
 */
export function noteServerBuild(buildId: string) {
  notifier?.noteServerBuild(buildId);
}

function createPageBuildUpdateNotifier() {
  const channel =
    typeof BroadcastChannel === "undefined"
      ? null
      : new BroadcastChannel(CHANNEL_NAME);
  const created = createBuildUpdateNotifier({
    // Next.js sets this from its deployment id (data-dpl-id), the same value
    // the server names in each mail engine response. Read when first needed,
    // after Next.js has registered it.
    readOwnBuildId: () => process.env.NEXT_DEPLOYMENT_ID || undefined,
    isDesktopApp: () => Boolean(getInboxZeroDesktopApp()),
    reload: () => window.location.reload(),
    offerReload: showUpdateAvailableToast,
    withdrawOffer: dismissUpdateAvailableToast,
    broadcast: (buildId) => {
      try {
        channel?.postMessage({ type: "server_build", buildId });
      } catch {
        // A closed channel only means the other tabs hear it from their own
        // engine's requests.
      }
    },
  });
  channel?.addEventListener("message", (event: MessageEvent) => {
    const message = event.data;
    if (message?.type === "server_build" && typeof message.buildId === "string")
      created.noteServerBuild(message.buildId, { fromPeer: true });
  });
  return created;
}
