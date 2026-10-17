// Kept free of `node:async_hooks` so modules that also reach browser bundles
// (provider retry, via `utils/error.ts`) can read the request deadline. The
// server-only `utils/request-deadline.ts` registers the real reader on import.
let readRequestDeadline: () => number | undefined = () => undefined;

export function setRequestDeadlineReader(reader: () => number | undefined) {
  readRequestDeadline = reader;
}

/** Epoch ms by which the current request must answer, if it has a deadline. */
export function getRequestDeadline(): number | undefined {
  return readRequestDeadline();
}

/**
 * Whether at least `reserveMs` remains before the current request's deadline,
 * so a loop can stop cleanly instead of being killed mid-item. Always true for
 * a request without a deadline.
 */
export function hasTimeBeforeRequestDeadline(reserveMs: number): boolean {
  const deadline = readRequestDeadline();
  return deadline === undefined || Date.now() + reserveMs < deadline;
}
