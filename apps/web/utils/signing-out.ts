let signingOut = false;
let controller = new AbortController();
const listeners = new Set<() => void>();

/**
 * Sign-out has begun. The session row is about to go, so any API request from
 * here on would answer 401 and be mistaken for an expired session racing the
 * sign-out redirect. Shared fetchers send nothing more, SWR pauses, and
 * in-flight requests are cancelled.
 */
export function startSigningOut() {
  if (signingOut) return;
  signingOut = true;
  controller.abort();
  for (const listener of listeners) listener();
}

export function isSigningOut() {
  return signingOut;
}

export function signingOutSignal() {
  return controller.signal;
}

/** Joins a caller's own abort signal with the sign-out one. */
export function withSigningOutSignal(signal: AbortSignal | null | undefined) {
  return signal
    ? AbortSignal.any([signal, controller.signal])
    : controller.signal;
}

export function onSigningOut(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function resetSigningOut() {
  signingOut = false;
  controller = new AbortController();
}
