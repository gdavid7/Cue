import {
  type OfficePackageResult,
  readOfficePackage,
} from "@/utils/attachments/office-package";

// Only office-package (and fflate) may be imported here: a module that also
// imports the worker client would pull this worker into its own chunk.
self.onmessage = async (event: MessageEvent<ArrayBuffer>) => {
  const result: OfficePackageResult = await readOfficePackage(
    new Uint8Array(event.data),
  ).catch(() => ({ refused: "invalid" }));
  self.postMessage(result, {
    transfer: "package" in result ? [result.package.buffer] : [],
  });
};
