import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  dedupeFilenames,
  selectUnderCap,
  zipAttachments,
  zipFilename,
} from "@/utils/attachments/download-all";

describe("zipFilename", () => {
  it("names the archive after the subject", () => {
    expect(zipFilename("Q3 contract")).toBe("Q3 contract attachments.zip");
  });

  it("removes characters that are not allowed in file names", () => {
    expect(zipFilename("Q1/Q2: plan?")).toBe("Q1 Q2 plan attachments.zip");
    expect(zipFilename('a\\b*c"d<e>f|g')).toBe("a b c d e f g attachments.zip");
  });

  it("strips control characters and collapses whitespace", () => {
    expect(zipFilename("  Plans\u0000 \n\t for   May  ")).toBe(
      "Plans for May attachments.zip",
    );
  });

  it("does not start or end the name with dots", () => {
    expect(zipFilename("..hidden..")).toBe("hidden attachments.zip");
  });

  it("falls back when nothing usable is left", () => {
    expect(zipFilename("")).toBe("attachments.zip");
    expect(zipFilename(" ???  ")).toBe("attachments.zip");
    expect(zipFilename(undefined)).toBe("attachments.zip");
  });

  it("keeps long subjects within a safe length without splitting a character", () => {
    const name = zipFilename("😀".repeat(200));
    expect(name.endsWith(" attachments.zip")).toBe(true);
    expect(Array.from(name).length).toBeLessThanOrEqual(120);
    expect(name).not.toContain("�");
  });
});

describe("dedupeFilenames", () => {
  it("leaves unique names alone", () => {
    expect(dedupeFilenames(["a.pdf", "b.pdf"])).toEqual(["a.pdf", "b.pdf"]);
  });

  it("numbers repeats before the extension", () => {
    expect(dedupeFilenames(["a.pdf", "a.pdf", "a.pdf"])).toEqual([
      "a.pdf",
      "a (1).pdf",
      "a (2).pdf",
    ]);
  });

  it("treats names that differ only by case as the same file", () => {
    expect(dedupeFilenames(["Report.PDF", "report.pdf"])).toEqual([
      "Report.PDF",
      "report (1).pdf",
    ]);
  });

  it("never reuses a name that already exists in the list", () => {
    const result = dedupeFilenames(["a.pdf", "a.pdf", "a (1).pdf"]);
    expect(new Set(result.map((name) => name.toLowerCase())).size).toBe(3);
  });

  it("handles names without an extension and dotfiles", () => {
    expect(dedupeFilenames(["notes", "notes", ".env", ".env"])).toEqual([
      "notes",
      "notes (1)",
      ".env",
      ".env (1)",
    ]);
  });

  it("keeps entries free of folder separators and falls back for empty names", () => {
    expect(dedupeFilenames(["../x.txt", "", ""])).toEqual([
      "x.txt",
      "attachment",
      "attachment (1)",
    ]);
  });
});

describe("selectUnderCap", () => {
  const file = (name: string, size: number) => ({ name, size });

  it("includes everything that fits", () => {
    const result = selectUnderCap([file("a", 40), file("b", 60)], 100);
    expect(result.included.map((f) => f.name)).toEqual(["a", "b"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips a file that would pass the cap and keeps later ones that fit", () => {
    const result = selectUnderCap(
      [file("a", 60), file("big", 50), file("c", 40)],
      100,
    );
    expect(result.included.map((f) => f.name)).toEqual(["a", "c"]);
    expect(result.skipped.map((f) => f.name)).toEqual(["big"]);
  });

  it("skips a single file larger than the cap", () => {
    const result = selectUnderCap([file("huge", 101)], 100);
    expect(result.included).toEqual([]);
    expect(result.skipped).toHaveLength(1);
  });

  it("treats a file of exactly the remaining room as fitting", () => {
    const result = selectUnderCap([file("a", 100)], 100);
    expect(result.included).toHaveLength(1);
  });

  it("counts a missing or invalid size as zero rather than dropping the file", () => {
    const result = selectUnderCap([file("a", Number.NaN), file("b", -5)], 100);
    expect(result.included).toHaveLength(2);
  });
});

describe("zipAttachments", () => {
  it("produces a zip that holds each file's bytes under its name", async () => {
    const blob = await zipAttachments([
      { name: "a.txt", data: new TextEncoder().encode("alpha") },
      { name: "b.bin", data: new Uint8Array([1, 2, 3]) },
    ]);
    const entries = unzipSync(new Uint8Array(await blob.arrayBuffer()));
    expect(Object.keys(entries).sort()).toEqual(["a.txt", "b.bin"]);
    expect(new TextDecoder().decode(entries["a.txt"])).toBe("alpha");
    expect(Array.from(entries["b.bin"] ?? [])).toEqual([1, 2, 3]);
    expect(blob.type).toBe("application/zip");
  });

  it("rejects when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      zipAttachments(
        [{ name: "a", data: new Uint8Array(1) }],
        controller.signal,
      ),
    ).rejects.toThrow();
  });
});
