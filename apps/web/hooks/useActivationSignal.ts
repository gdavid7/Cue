"use client";

import { useEffect } from "react";
import { recordActivationSignalAction } from "@/utils/actions/activation";
import type { ActivationSignalBody } from "@/utils/actions/activation.validation";

type ActivationSignal = ActivationSignalBody["event"];

// The server's Redis claim is the real once-per-mailbox dedupe; this only
// spares the round trip for the rest of the page session.
const reported = new Set<string>();

/** Fire and forget: a lost signal costs one funnel count, never the user's action. */
export function reportActivationSignal(
  emailAccountId: string,
  event: ActivationSignal,
) {
  const key = `${emailAccountId}:${event}`;
  if (reported.has(key)) return;
  reported.add(key);
  recordActivationSignalAction(emailAccountId, { event }).catch(() => {});
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
