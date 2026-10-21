import { zipSync } from "fflate";
import { encodeImage } from "utif2";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getAttachmentImagePreview,
  getAttachmentPreview,
  getAttachmentPreviewTarget,
  isPreviewableAttachment,
  isSafeToUnpack,
  OFFICE_PREVIEW_MAX_BYTES,
  isPreviewableImageType,
} from "./attachment-preview";

describe("attachment image previews", () => {
  it.each([
    ["image/png", [137, 80, 78, 71, 13, 10, 26, 10]],
    ["image/jpeg", [255, 216, 255, 224]],
    ["image/gif", [71, 73, 70, 56, 55, 97]],
    ["image/gif", [71, 73, 70, 56, 57, 97]],
    [
      "image/webp",
      [82, 73, 70, 70, 20, 0, 0, 0, 87, 69, 66, 80, 86, 80, 56, 32],
    ],
  ] as const)("derives %s from its signature and preserves bytes", async (expectedType, signature) => {
    for (const type of [
      "image/svg+xml",
      "text/html",
      "application/octet-stream",
      expectedType,
      "",
    ]) {
      const blob = new Blob([new Uint8Array(signature)], { type });
      const preview = await getAttachmentImagePreview(blob);
      expect(preview?.type).toBe(expectedType);
      expect(await preview?.arrayBuffer()).toEqual(await blob.arrayBuffer());
    }
  });

  it.each([
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "<!doctype html><html><body>Document</body></html>",
    "<?xml version='1.0'?><html xmlns='http://www.w3.org/1999/xhtml'/>",
    "%PDF-1.7",
    "GIF8",
    "RIFF1234WAVE",
    "RIFF1234WEBP",
    "",
  ])("rejects non-raster or incomplete bytes despite raster MIME metadata: %s", async (content) => {
    expect(
      await getAttachmentImagePreview(
        new Blob([content], { type: "image/png" }),
      ),
    ).toBeUndefined();
  });

  it("does not offer active or unknown image formats as attachment previews", () => {
    for (const type of [
      "image/svg+xml",
      "image/svg+xml; charset=utf-8",
      "image/unknown",
      "text/html",
      "application/pdf",
    ]) {
      expect(isPreviewableImageType(type)).toBe(false);
    }
    for (const type of [
      "image/png",
      "IMAGE/JPEG",
      "image/gif; charset=binary",
      "image/webp",
      "image/tiff",
    ]) {
      expect(isPreviewableImageType(type)).toBe(true);
    }
  });

  it("types PDFs from their signature for the full preview", async () => {
    for (const [type, content] of [
      ["application/octet-stream", "%PDF-1.7\n"],
      ["text/html", "%PDF-1.7\n"],
      ["", "\r\n%PDF-1.4\n"],
    ]) {
      const blob = new Blob([content], { type });
      const preview = await getAttachmentPreview(blob);
      expect(preview?.type).toBe("application/pdf");
      expect(await preview?.arrayBuffer()).toEqual(await blob.arrayBuffer());
    }
  });

  it.each([
    "<!doctype html><html><body>Document</body></html>",
    "<svg xmlns='http://www.w3.org/2000/svg'></svg>",
    "%PDF",
    "",
  ])("does not open non-PDF bytes declared as PDF: %s", async (content) => {
    expect(
      await getAttachmentPreview(
        new Blob([content], { type: "application/pdf" }),
      ),
    ).toBeUndefined();
  });

  describe("TIFF images", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("converts TIFF bytes to a PNG that browsers can render", async () => {
      const drawn = stubCanvas();
      const rgba = new Uint8Array([255, 0, 0, 255, 0, 0, 255, 128]);
      const tiff = new Blob([encodeImage(rgba, 2, 1)], {
        type: "application/octet-stream",
      });

      const preview = await getAttachmentImagePreview(tiff);

      expect(preview?.type).toBe("image/png");
      expect(drawn).toEqual([{ width: 2, height: 1, pixels: [...rgba] }]);
    });

    it("does not decode TIFF images too large to render", async () => {
      const drawn = stubCanvas();
      const tiff = new Blob([
        encodeImage(new Uint8Array(4), 1, 1, {
          t256: [20_000],
          t257: [20_000],
        } as never),
      ]);

      expect(await getAttachmentImagePreview(tiff)).toBeUndefined();
      expect(drawn).toEqual([]);
    });
  });
});

function stubCanvas() {
  const drawn: { width: number; height: number; pixels: number[] }[] = [];
  vi.stubGlobal(
    "ImageData",
    class {
      data: Uint8ClampedArray;
      width: number;
      height: number;
      constructor(data: Uint8ClampedArray, width: number, height: number) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    },
  );
  vi.stubGlobal(
    "OffscreenCanvas",
    class {
      getContext() {
        return {
          putImageData: (image: ImageData) =>
            drawn.push({
              width: image.width,
              height: image.height,
              pixels: [...image.data],
            }),
        };
      }
      async convertToBlob({ type }: { type: string }) {
        return new Blob([new Uint8Array([137, 80, 78, 71])], { type });
      }
    },
  );
  return drawn;
}

describe("attachment preview routing", () => {
  const DOCX =
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const XLSX =
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
  const PPTX =
    "application/vnd.openxmlformats-officedocument.presentationml.presentation";
  const zip = () =>
    new Blob([
      zipSync({
        "word/document.xml": new TextEncoder().encode("<w:document/>"),
      }),
    ]);

  it.each([
    [DOCX, "notes", "docx"],
    ["application/octet-stream", "Notes.DOCX", "docx"],
    [XLSX, "budget", "xlsx"],
    ["application/octet-stream", "budget.xlsx", "xlsx"],
  ] as const)("previews a %s named %s as %s", async (mimeType, filename, kind) => {
    expect(isPreviewableAttachment({ mimeType, filename })).toBe(true);
    const target = await getAttachmentPreviewTarget(zip(), {
      mimeType,
      filename,
    });
    expect(target?.kind).toBe(kind);
  });

  // No in-browser renderer for these, so they keep the download button only.
  it.each([
    [PPTX, "deck.pptx"],
    ["application/msword", "old.doc"],
    ["application/vnd.ms-excel", "old.xls"],
    ["application/zip", "archive.zip"],
  ])("leaves %s (%s) download-only", async (mimeType, filename) => {
    expect(isPreviewableAttachment({ mimeType, filename })).toBe(false);
    expect(
      await getAttachmentPreviewTarget(zip(), { mimeType, filename }),
    ).toBeUndefined();
  });

  it("trusts the bytes over an Office name", async () => {
    const pdf = new Blob([new TextEncoder().encode("%PDF-1.7\n")]);
    const target = await getAttachmentPreviewTarget(pdf, {
      mimeType: DOCX,
      filename: "report.docx",
    });
    expect(target?.kind).toBe("file");
    expect(target && "file" in target && target.file.type).toBe(
      "application/pdf",
    );

    const html = new Blob(["<html><script>alert(1)</script></html>"]);
    expect(
      await getAttachmentPreviewTarget(html, {
        mimeType: XLSX,
        filename: "budget.xlsx",
      }),
    ).toBeUndefined();
  });

  // Unpacked on the page, so a bomb must be refused before parsing.
  it("refuses a package that would inflate far past its size", async () => {
    const bomb = zipSync({
      "word/document.xml": new Uint8Array(2 * 1024 * 1024),
    });
    expect(isSafeToUnpack(bomb)).toBe(false);
    expect(
      await getAttachmentPreviewTarget(new Blob([bomb]), {
        mimeType: DOCX,
        filename: "bomb.docx",
      }),
    ).toEqual({ kind: "tooLarge" });
  });

  it("refuses a package with an absurd number of parts", () => {
    const parts: Record<string, Uint8Array> = {};
    for (let index = 0; index < 5001; index++)
      parts[`xl/part${index}.xml`] = new Uint8Array(0);
    expect(isSafeToUnpack(zipSync(parts))).toBe(false);
  });

  it("refuses a file over the Office preview cap without unpacking it", async () => {
    const big = new Blob([
      new Uint8Array([80, 75, 3, 4]),
      new Uint8Array(OFFICE_PREVIEW_MAX_BYTES),
    ]);
    expect(
      await getAttachmentPreviewTarget(big, {
        mimeType: XLSX,
        filename: "huge.xlsx",
      }),
    ).toEqual({ kind: "tooLarge" });
  });

  it("refuses a file that only starts like a zip", () => {
    expect(isSafeToUnpack(new Uint8Array([80, 75, 3, 4, 1, 2, 3]))).toBe(false);
  });
});
