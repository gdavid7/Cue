import { AsyncZipDeflate, Zip } from "fflate";

export const DOWNLOAD_ALL_MAX_BYTES = 100 * 1024 * 1024;

const FALLBACK_ARCHIVE_NAME = "attachments.zip";
const FALLBACK_FILE_NAME = "attachment";
const MAX_SUBJECT_CHARACTERS = 100;
// Windows refuses these names, with or without an extension.
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

export function zipFilename(subject: string | undefined): string {
  const cleaned = cleanName(
    Array.from(cleanName(subject ?? ""))
      .slice(0, MAX_SUBJECT_CHARACTERS)
      .join(""),
  );
  return cleaned
    ? `${cleaned} ${FALLBACK_ARCHIVE_NAME}`
    : FALLBACK_ARCHIVE_NAME;
}

/** Two entries with one name would make one of them unreachable in most unzip tools. */
export function dedupeFilenames(names: string[]): string[] {
  const taken = new Set<string>();
  return names.map((raw) => {
    const last = raw.split(/[\\/]/).pop() ?? "";
    const cleaned = cleanName(last) || FALLBACK_FILE_NAME;
    const name = WINDOWS_DEVICE_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
    const dot = name.lastIndexOf(".");
    const stem = dot > 0 ? name.slice(0, dot) : name;
    const extension = dot > 0 ? name.slice(dot) : "";
    let candidate = name;
    for (let n = 1; taken.has(candidate.toLowerCase()); n++)
      candidate = `${stem} (${n})${extension}`;
    taken.add(candidate.toLowerCase());
    return candidate;
  });
}

function cleanName(raw: string): string {
  return (
    raw
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what is being removed
      .replace(/[\u0000-\u001f\u007f\\/:*?"<>|]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/^[.\s]+|[.\s]+$/g, "")
  );
}

export function selectUnderCap<T extends { size: number }>(
  items: T[],
  maxBytes: number,
): { included: T[]; skipped: T[] } {
  const included: T[] = [];
  const skipped: T[] = [];
  let total = 0;
  for (const item of items) {
    const size = Number.isFinite(item.size) && item.size > 0 ? item.size : 0;
    if (total + size > maxBytes) {
      skipped.push(item);
      continue;
    }
    total += size;
    included.push(item);
  }
  return { included, skipped };
}

/**
 * Deflates on fflate's worker threads, so a large archive doesn't block the
 * page. Names must already be unique (see dedupeFilenames).
 */
export function zipAttachments(
  files: { name: string; data: Uint8Array }[],
  signal?: AbortSignal,
): Promise<Blob> {
  return new Promise<Blob>((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
      return;
    }
    const chunks: Uint8Array<ArrayBuffer>[] = [];
    const zip = new Zip((error, chunk, final) => {
      if (error) {
        fail(error);
        return;
      }
      chunks.push(chunk as Uint8Array<ArrayBuffer>);
      if (final) {
        signal?.removeEventListener("abort", onAbort);
        resolve(new Blob(chunks, { type: "application/zip" }));
      }
    });
    const onAbort = () =>
      fail(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    function fail(error: unknown) {
      signal?.removeEventListener("abort", onAbort);
      zip.terminate();
      reject(error);
    }
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      for (const { name, data } of files) {
        const entry = new AsyncZipDeflate(name, { level: 6 });
        zip.add(entry);
        // push hands the buffer to a worker, which detaches `data` here.
        entry.push(data, true);
      }
      zip.end();
    } catch (error) {
      fail(error);
    }
  });
}
