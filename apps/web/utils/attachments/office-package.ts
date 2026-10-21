import { Inflate, type Zippable, zipSync } from "fflate";

const MAX_UNPACKED_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 5000;
// Office XML compresses about 10-20x; far beyond that is a bomb.
const MAX_RATIO = 200;
const RATIO_FLOOR_BYTES = 1024 * 1024;
// Deflate expands at most ~1032x, so one push can overshoot a limit by about
// 1 MB at most before it's caught.
const PUSH_BYTES = 1024;
// Hands the main thread back this often, so closing the preview isn't stuck
// behind a large package.
const YIELD_EVERY_BYTES = 4 * 1024 * 1024;

export type OfficePackageResult =
  | { package: Uint8Array }
  | { refused: "tooLarge" | "invalid" };

/**
 * Unpacks an Office file (a zip) under hard limits and repacks what it found,
 * uncompressed. The renderers' unzippers trust the sizes a zip declares and
 * inflate first, so a part that lies about its size could inflate gigabytes;
 * here every part is inflated with a running count and dropped the moment it
 * outgrows what it declared or the package outgrows its budget. The renderer
 * then only ever reads bytes that were counted.
 */
export async function readOfficePackage(
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<OfficePackageResult> {
  const entries = readCentralDirectory(bytes);
  if (!entries) return { refused: "invalid" };
  if (entries.length > MAX_ENTRIES) return { refused: "tooLarge" };
  // Real Office files never repeat a part or point two parts at the same
  // bytes; overlapping entries would multiply what one file can unpack.
  if (
    new Set(entries.map((entry) => entry.name)).size !== entries.length ||
    new Set(entries.map((entry) => entry.localOffset)).size !== entries.length
  )
    return { refused: "invalid" };
  // No Office part has this name, and object-keyed zip code would treat it as
  // the object's prototype.
  if (entries.some((entry) => entry.name === "__proto__"))
    return { refused: "invalid" };
  let declared = 0;
  for (const entry of entries) {
    declared += entry.size;
    if (
      entry.size > RATIO_FLOOR_BYTES &&
      entry.size > Math.max(entry.compressedSize, 1) * MAX_RATIO
    )
      return { refused: "tooLarge" };
  }
  if (declared > MAX_UNPACKED_BYTES) return { refused: "tooLarge" };

  const files: Zippable = Object.create(null);
  const pace = createPacer(signal);
  for (const entry of entries) {
    if (entry.name.endsWith("/")) continue;
    const data = readEntryData(bytes, entry);
    // Office writes parts stored (0) or deflated (8), nothing else.
    if (!data || (entry.method !== 0 && entry.method !== 8))
      return { refused: "invalid" };
    let unpacked: Uint8Array | undefined = data;
    if (entry.method === 8) {
      const inflated = await inflateBounded(data, entry.size, pace);
      if (inflated.produced > entry.size) return { refused: "tooLarge" };
      unpacked = inflated.output;
    }
    // A part shorter than it says, or a corrupt one, isn't a real package.
    if (!unpacked || unpacked.length !== entry.size)
      return { refused: "invalid" };
    files[entry.name] = [unpacked, { level: 0 }];
    await pace(unpacked.length);
  }
  return { package: zipSync(files) };
}

/**
 * Inflates `data`, keeping at most `limit` bytes; past that it stops feeding
 * the inflater and returns no output. `produced` is what was inflated in all.
 * `pace` hands the page back between pushes, and throws once aborted.
 */
export async function inflateBounded(
  data: Uint8Array,
  limit: number,
  pace: Pacer = async () => {},
) {
  const chunks: Uint8Array[] = [];
  let produced = 0;
  let over = false;
  let pushed = 0;
  const inflater = new Inflate((chunk) => {
    produced += chunk.length;
    pushed += chunk.length;
    if (produced > limit) over = true;
    else chunks.push(chunk);
  });
  for (let offset = 0; offset < data.length && !over; offset += PUSH_BYTES) {
    try {
      inflater.push(
        data.subarray(offset, offset + PUSH_BYTES),
        offset + PUSH_BYTES >= data.length,
      );
    } catch {
      return { produced };
    }
    await pace(pushed);
    pushed = 0;
  }
  if (over) return { produced };
  const output = new Uint8Array(produced);
  let position = 0;
  for (const chunk of chunks) {
    output.set(chunk, position);
    position += chunk.length;
  }
  return { output, produced };
}

type Pacer = (bytes: number) => Promise<void>;

/**
 * Counts work in bytes and, every YIELD_EVERY_BYTES, gives the main thread
 * back and stops if the preview was closed.
 */
function createPacer(signal?: AbortSignal): Pacer {
  let sinceYield = 0;
  return async (bytes) => {
    sinceYield += bytes;
    if (sinceYield < YIELD_EVERY_BYTES) return;
    sinceYield = 0;
    await new Promise((resolve) => setTimeout(resolve, 0));
    signal?.throwIfAborted();
  };
}

type Entry = {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  localOffset: number;
};

const EOCD_SIGNATURE = 0x06_05_4b_50;
const CENTRAL_SIGNATURE = 0x02_01_4b_50;
const LOCAL_SIGNATURE = 0x04_03_4b_50;
const ZIP64_MARKER = 0xff_ff_ff_ff;

function readCentralDirectory(bytes: Uint8Array): Entry[] | undefined {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // The end record is the last 22 bytes, plus a comment of up to 64 KB.
  let end = -1;
  for (
    let offset = bytes.length - 22;
    offset >= Math.max(0, bytes.length - 22 - 0xff_ff);
    offset--
  ) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      end = offset;
      break;
    }
  }
  if (end < 0) return;
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  // Office files under the size cap never need zip64.
  if (count === 0xff_ff || offset === ZIP64_MARKER) return;

  const decoder = new TextDecoder();
  const entries: Entry[] = [];
  for (let index = 0; index < count; index++) {
    if (
      offset + 46 > bytes.length ||
      view.getUint32(offset, true) !== CENTRAL_SIGNATURE
    )
      return;
    const flags = view.getUint16(offset + 8, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    // Encrypted parts can't be previewed.
    if (flags & 1) return;
    if (compressedSize === ZIP64_MARKER || size === ZIP64_MARKER) return;
    const nameEnd = offset + 46 + nameLength;
    if (nameEnd > bytes.length) return;
    entries.push({
      name: decoder.decode(bytes.subarray(offset + 46, nameEnd)),
      method: view.getUint16(offset + 10, true),
      compressedSize,
      size,
      localOffset,
    });
    offset = nameEnd + extraLength + commentLength;
  }
  return entries;
}

function readEntryData(bytes: Uint8Array, entry: Entry) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const header = entry.localOffset;
  if (
    header + 30 > bytes.length ||
    view.getUint32(header, true) !== LOCAL_SIGNATURE
  )
    return;
  const start =
    header +
    30 +
    view.getUint16(header + 26, true) +
    view.getUint16(header + 28, true);
  const end = start + entry.compressedSize;
  if (end > bytes.length) return;
  return bytes.subarray(start, end);
}
