import {
  claimStaleDeploymentReload,
  isEditingText,
  showStaleDeploymentToast,
} from "@/utils/stale-deployment";

const RETRY_DELAYS_MS = [300, 1000];

/**
 * Loads a lazily imported chunk, retrying briefly. React.lazy and next/dynamic
 * keep a rejected import for the life of the page, so a chunk that failed once
 * (a flaky network, or a deploy that removed the old build's files) would stay
 * broken even after "Try again". Retrying covers a blip; after that the page
 * reloads once onto the current build, guarded against a reload loop. While
 * the user is typing, or once the guard has used its reload, a "Reload" toast
 * lets them choose the moment instead.
 */
export async function loadChunk<T>(
  load: () => Promise<T>,
  {
    reloadOnFailure = true,
    delaysMs = RETRY_DELAYS_MS,
    reload = () => window.location.reload(),
    storage = getSessionStorage(),
  }: {
    /** Off for background preloads, which must never reload the page. */
    reloadOnFailure?: boolean;
    delaysMs?: number[];
    reload?: () => void;
    storage?: Pick<Storage, "getItem" | "setItem"> | null;
  } = {},
): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await load();
    } catch (error) {
      const delay = delaysMs[attempt];
      if (delay !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        continue;
      }
      if (!reloadOnFailure || typeof window === "undefined") throw error;
      // A reload mid-keystroke could drop the last few characters of a draft.
      if (
        !isEditingText() &&
        storage &&
        claimStaleDeploymentReload(storage, Date.now())
      ) {
        reload();
        // The page is going away; settling would only flash an error first.
        return new Promise<never>(() => {});
      }
      // Offline, the failure says nothing about a new version.
      if (navigator.onLine !== false) showStaleDeploymentToast();
      throw error;
    }
  }
}

function getSessionStorage() {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}
