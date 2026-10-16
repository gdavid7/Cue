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
