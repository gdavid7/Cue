import { readFileSync } from "node:fs";
import { unzipSync, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  inflateBounded,
  readOfficePackage,
} from "@/utils/attachments/office-package";

const DOCX = "__tests__/playwright/emulated/mail/fixtures/planning-notes.docx";
const MB = 1024 * 1024;

describe("readOfficePackage", () => {
  it("repacks a real document part for part, uncompressed", async () => {
    const original = new Uint8Array(readFileSync(DOCX));

    const result = await readOfficePackage(original);

    if (!("package" in result)) throw new Error("refused a real document");
    expect(unzipSync(result.package)).toEqual(unzipSync(original));
    // Stored, so the renderer's unzipper has nothing left to inflate.
    expect(result.package.length).toBeGreaterThan(
      Object.values(unzipSync(original)).reduce((sum, f) => sum + f.length, 0),
    );
  });

  // A part declared at 1 KB that really inflates to 16 MB passes every check
  // on declared sizes; the renderers' unzipper would inflate all of it.
  it("refuses a part that inflates past its declared size", async () => {
    const lying = declareSizes(
      zipSync({ "word/document.xml": new Uint8Array(16 * MB) }),
      1024,
    );

    expect(await readOfficePackage(lying)).toEqual({ refused: "tooLarge" });
  });

  it("refuses a part that is shorter than it says", async () => {
    const short = declareSizes(
      zipSync({ "word/document.xml": new Uint8Array(1000).fill(65) }),
      2000,
    );

    expect(await readOfficePackage(short)).toEqual({ refused: "invalid" });
  });

  it("refuses a package with an absurd number of parts", async () => {
    const parts: Record<string, Uint8Array> = {};
    for (let index = 0; index < 5001; index++)
      parts[`xl/part${index}.xml`] = new Uint8Array(0);

    expect(await readOfficePackage(zipSync(parts))).toEqual({
      refused: "tooLarge",
    });
  });

  it("refuses a declared bomb without inflating it", async () => {
    const bomb = zipSync({ "word/document.xml": new Uint8Array(2 * MB) });

    expect(await readOfficePackage(bomb)).toEqual({ refused: "tooLarge" });
  });

  // Real Office files have neither; overlapping entries would multiply what
  // one small file can unpack.
  it("refuses a package that repeats a part name", async () => {
    const zip = zipSync({ "a.xml": text("one"), "b.xml": text("two") });
    expect(await readOfficePackage(renamePart(zip, "b.xml", "a.xml"))).toEqual({
      refused: "invalid",
    });
  });

  it("refuses two parts pointing at the same bytes", async () => {
    const zip = zipSync({ "a.xml": text("one"), "b.xml": text("one") });
    const view = new DataView(zip.buffer);
    const centrals = offsetsOf(zip, 0x02_01_4b_50);
    view.setUint32(
      centrals[1] + 42,
      view.getUint32(centrals[0] + 42, true),
      true,
    );

    expect(await readOfficePackage(zip)).toEqual({ refused: "invalid" });
  });

  it("refuses a part named __proto__ without polluting anything", async () => {
    const zip = zipSync({ "abcde.xml": text("hello") });

    expect(
      await readOfficePackage(renamePart(zip, "abcde.xml", "__proto__")),
    ).toEqual({ refused: "invalid" });
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  it("stops inside a large part once the preview is closed", async () => {
    // Random bytes don't compress, so every check on declared sizes passes.
    const noise = new Uint8Array(6 * MB);
    for (let offset = 0; offset < noise.length; offset += 65_536)
      crypto.getRandomValues(noise.subarray(offset, offset + 65_536));
    const controller = new AbortController();
    controller.abort();

    await expect(
      readOfficePackage(
        zipSync({ "word/document.xml": noise }),
        controller.signal,
      ),
    ).rejects.toThrow();
  });

  it("refuses bytes that only start like a zip", async () => {
    expect(
      await readOfficePackage(new Uint8Array([80, 75, 3, 4, 1, 2, 3])),
    ).toEqual({ refused: "invalid" });
  });
});

describe("inflateBounded", () => {
  it("stops inflating soon after the limit instead of finishing", async () => {
    const deflated = zipSync({ part: new Uint8Array(16 * MB) }, { level: 1 });
    const data = entryData(deflated);

    const { output, produced } = await inflateBounded(data, 1024);

    expect(output).toBeUndefined();
    // At most one push past the limit, never the 16 MB the data holds.
    expect(produced).toBeLessThan(2 * MB);
  });

  it("returns everything within the limit", async () => {
    const text = new TextEncoder().encode("<w:document/>".repeat(100));
    const data = entryData(zipSync({ part: text }));

    expect((await inflateBounded(data, text.length)).output).toEqual(text);
  });
});

/** Rewrites every part's declared uncompressed size, local and central. */
function declareSizes(zip: Uint8Array, size: number) {
  const bytes = zip.slice();
  const view = new DataView(bytes.buffer);
  for (let offset = 0; offset + 4 <= bytes.length; offset++) {
    const signature = view.getUint32(offset, true);
    if (signature === 0x04_03_4b_50) view.setUint32(offset + 22, size, true);
    if (signature === 0x02_01_4b_50) view.setUint32(offset + 24, size, true);
  }
  return bytes;
}

/** The deflate stream of a single-part zip. */
function entryData(zip: Uint8Array) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const compressed = view.getUint32(18, true);
  const start = 30 + view.getUint16(26, true) + view.getUint16(28, true);
  return zip.subarray(start, start + compressed);
}

function text(value: string) {
  return new TextEncoder().encode(value);
}

function offsetsOf(zip: Uint8Array, signature: number) {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const offsets: number[] = [];
  for (let offset = 0; offset + 4 <= zip.length; offset++)
    if (view.getUint32(offset, true) === signature) offsets.push(offset);
  return offsets;
}

/** Renames a part in both headers; the names must be the same length. */
function renamePart(zip: Uint8Array, from: string, to: string) {
  const bytes = zip.slice();
  const fromBytes = text(from);
  if (to.length !== from.length) throw new Error("names must match in length");
  const toBytes = text(to);
  for (let offset = 0; offset + fromBytes.length <= bytes.length; offset++)
    if (fromBytes.every((byte, index) => bytes[offset + index] === byte))
      bytes.set(toBytes, offset);
  return bytes;
}
