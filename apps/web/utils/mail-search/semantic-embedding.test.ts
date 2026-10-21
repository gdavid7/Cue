import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isPinnedModelFile,
  messageEmbeddingText,
  SEMANTIC_MODEL,
  type SemanticModelFile,
  semanticModelFilePath,
} from "@/utils/mail-search/semantic-embedding";

describe("semantic model files", () => {
  const files = Object.keys(SEMANTIC_MODEL.files) as SemanticModelFile[];

  it.each(
    files,
  )("serves %s from the app's own public folder as the pinned file", async (file) => {
    const path = semanticModelFilePath(file);
    expect(path).toMatch(/^\/models\//);
    expect(path).toContain(`/${SEMANTIC_MODEL.revision}/`);
    const bytes = new Uint8Array(
      await readFile(join(import.meta.dirname, "../../public", path)),
    );
    expect(await isPinnedModelFile(file, bytes)).toBe(true);
  });
});

describe("messageEmbeddingText", () => {
  it("joins subject, sender name and body, without the address", () => {
    expect(
      messageEmbeddingText({
        subject: "Kitchen remodel proposal",
        from: '"Ben Alvarez" <ben@remodel.example>',
        body: "Hi Alex,\n\n attached is the proposal.",
      }),
    ).toBe(
      "Kitchen remodel proposal. Ben Alvarez. Hi Alex, attached is the proposal.",
    );
  });
});
