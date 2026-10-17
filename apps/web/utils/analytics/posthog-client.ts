import type { PostHog } from "posthog-js";
import { useSyncExternalStore } from "react";
import { env } from "@/env";
import { loadChunk } from "@/utils/load-chunk";

// Calls made while PostHog's ~300KB library is still loading. A cap keeps a
// page whose load never finishes from growing the queue without bound.
const MAX_PENDING_CALLS = 500;

let client: PostHog | undefined;
let loadStarted = false;
let loadFailed = false;
let pending: ((client: PostHog) => void)[] = [];
let activeFlags: string[] = [];
const flagListeners = new Set<() => void>();
const settledListeners = new Set<() => void>();

/**
 * The PostHog calls the app makes, usable before the library has loaded:
 * calls wait for `loadPostHog` and then run in order. Without a PostHog key
 * they do nothing and the library is never downloaded.
 */
export const posthog: Pick<
  PostHog,
  | "capture"
  | "identify"
  | "register"
  | "setPersonProperties"
  | "getEarlyAccessFeatures"
  | "updateEarlyAccessFeatureEnrollment"
> = {
  capture: (event, properties, options) => {
    // A queued event keeps the time it happened, not the time it was sent.
    const timestamp = client ? undefined : new Date();
    whenLoaded((loaded) =>
      loaded.capture(
        event,
        properties,
        timestamp ? { timestamp, ...options } : options,
      ),
    );
  },
  identify: (...args) => whenLoaded((loaded) => loaded.identify(...args)),
  register: (...args) => whenLoaded((loaded) => loaded.register(...args)),
  setPersonProperties: (...args) =>
    whenLoaded((loaded) => loaded.setPersonProperties(...args)),
  getEarlyAccessFeatures: (...args) =>
    whenLoaded((loaded) => loaded.getEarlyAccessFeatures(...args)),
  updateEarlyAccessFeatureEnrollment: (...args) =>
    whenLoaded((loaded) => loaded.updateEarlyAccessFeatureEnrollment(...args)),
};

export type PostHogClient = typeof posthog;

/**
 * Downloads and starts PostHog once, then replays the calls made meanwhile.
 * `init` configures the instance before any queued call reaches it.
 */
export function loadPostHog(init: (instance: PostHog, key: string) => void) {
  const key = env.NEXT_PUBLIC_POSTHOG_KEY;
  if (!key || loadStarted || typeof window === "undefined") return;
  loadStarted = true;

  loadChunk(() => import("posthog-js"), { reloadOnFailure: false })
    .then(({ default: instance }) => {
      init(instance, key);
      client = instance;
      // Flags persisted from an earlier visit are usable before /flags answers.
      activeFlags = instance.featureFlags?.getFlags() ?? [];
      notify(flagListeners);
      const calls = pending;
      pending = [];
      for (const call of calls) call(instance);
      instance.onFeatureFlags((flags) => {
        activeFlags = flags;
        notify(flagListeners);
      });
      notify(settledListeners);
    })
    .catch(() => {
      loadFailed = true;
      pending = [];
      notify(settledListeners);
    });
}

/**
 * Resolves once queued calls have reached PostHog, or after `timeoutMs` if it
 * is still loading, so a navigation away (such as a sign-in redirect) can give
 * an event a moment to leave without ever being held up for long.
 */
export function whenReady(timeoutMs: number): Promise<void> {
  if (client || loadFailed || !env.NEXT_PUBLIC_POSTHOG_KEY) {
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timeout);
      settledListeners.delete(done);
      resolve();
    };
    const timeout = setTimeout(done, timeoutMs);
    settledListeners.add(done);
  });
}

export function useFeatureFlagEnabled(flag: string) {
  return useSyncExternalStore(
    subscribeToFlags,
    () => client?.isFeatureEnabled(flag),
    () => undefined,
  );
}

export function useActiveFeatureFlags() {
  return useSyncExternalStore(
    subscribeToFlags,
    () => activeFlags,
    () => activeFlags,
  );
}

function whenLoaded(call: (client: PostHog) => void) {
  if (client) {
    call(client);
    return;
  }
  if (
    !loadFailed &&
    env.NEXT_PUBLIC_POSTHOG_KEY &&
    typeof window !== "undefined" &&
    pending.length < MAX_PENDING_CALLS
  ) {
    pending.push(call);
  }
}

function subscribeToFlags(listener: () => void) {
  flagListeners.add(listener);
  return () => {
    flagListeners.delete(listener);
  };
}

function notify(listeners: Set<() => void>) {
  for (const listener of [...listeners]) listener();
}
