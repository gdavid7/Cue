import type { OfficePackageResult } from "@/utils/attachments/office-package";

/**
 * Runs readOfficePackage in a worker so a large package never blocks the
 * page. `bytes` is transferred, so it's unusable here afterwards, and so is
 * the repacked package coming back. Aborting terminates the worker at once;
 * a worker that fails to load or crashes counts as an invalid package.
 */
export function readOfficePackageInWorker(
  bytes: ArrayBuffer,
  signal?: AbortSignal,
): Promise<OfficePackageResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    let worker: Worker | undefined;
    const finish = () => {
      worker?.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason);
    };
    const refuse = () => {
      finish();
      resolve({ refused: "invalid" });
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    // A CSP that blocks the worker, or bytes that can't be transferred, throw
    // here rather than reaching onerror.
    try {
      worker = new Worker(
        new URL("./office-package-worker.ts", import.meta.url),
        { type: "module" },
      );
      worker.onmessage = (event: MessageEvent<unknown>) => {
        finish();
        resolve(toOfficePackageResult(event.data));
      };
      worker.onerror = worker.onmessageerror = (event: Event) => {
        event.preventDefault();
        refuse();
      };
      worker.postMessage(bytes, [bytes]);
    } catch {
      refuse();
    }
  });
}

// The renderers must only ever get a package the worker counted.
function toOfficePackageResult(data: unknown): OfficePackageResult {
  if (typeof data !== "object" || data === null) return { refused: "invalid" };
  if ("package" in data && data.package instanceof Uint8Array)
    return { package: data.package };
  if (
    "refused" in data &&
    (data.refused === "tooLarge" || data.refused === "invalid")
  )
    return { refused: data.refused };
  return { refused: "invalid" };
}
