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
    const worker = new Worker(
      new URL("./office-package-worker.ts", import.meta.url),
      { type: "module" },
    );
    const finish = () => {
      worker.terminate();
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = () => {
      finish();
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    worker.onmessage = (event: MessageEvent<OfficePackageResult>) => {
      finish();
      resolve(event.data);
    };
    worker.onerror = worker.onmessageerror = (event: Event) => {
      event.preventDefault();
      finish();
      resolve({ refused: "invalid" });
    };
    worker.postMessage(bytes, [bytes]);
  });
}
