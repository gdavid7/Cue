"use client";

import { useEffect } from "react";
import { recordActivationSignalAction } from "@/utils/actions/activation";
import type {
  ActivationSignal,
  ActivationSignalBody,
} from "@/utils/actions/activation.validation";
import { runWhenIdle } from "@/utils/analytics/summary-flush";
import { createBrowserCache } from "@/utils/browser-cache";

// Remembers in this browser which signals the server has taken, so a page
// load doesn't ask again. It is cleared on sign-out, and the server's Redis
// claim stays the real once-per-mailbox dedupe.
const taken = createBrowserCache<true>({
  name: "activation",
  ttlMs: 400 * 24 * 60 * 60 * 1000,
  maxEntries: 8,
});
// Calls in flight, and those taken this session when storage is blocked.
const inFlight = new Set<string>();
const takenThisSession = new Set<string>();

/**
 * Fire and forget: a lost signal costs one funnel count, never the user's
 * action. A failed call is tried again the next time the step happens, with
 * that time's `details`.
 */
export function reportActivationSignal(
  emailAccountId: string,
  event: ActivationSignal,
  details?: Omit<ActivationSignalBody, "event">,
) {
  const key = `${emailAccountId}:${event}`;
  if (inFlight.has(key) || takenThisSession.has(key)) return;
  if (taken.get(emailAccountId, event)) return;
  inFlight.add(key);
  // After the user's own server actions, not queued ahead of them.
  runWhenIdle(() => {
    recordActivationSignalAction(emailAccountId, { ...details, event })
      .then((result) => {
        if (result?.serverError || result?.validationErrors) return;
        takenThisSession.add(key);
        taken.set(emailAccountId, event, true);
      })
      .catch(() => {})
      .finally(() => inFlight.delete(key));
  });
}

export function useActivationSignal(
  emailAccountId: string | undefined,
  event: ActivationSignal,
  happened: boolean,
) {
  useEffect(() => {
    if (emailAccountId && happened)
      reportActivationSignal(emailAccountId, event);
  }, [emailAccountId, event, happened]);
}
