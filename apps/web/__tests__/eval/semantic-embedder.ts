import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as ort from "onnxruntime-web/wasm";
import {
  SEMANTIC_MODEL,
  type SemanticModelFile,
  semanticModelFileUrl,
} from "@/utils/mail-search/semantic-embedding";
import { createTextEmbedder } from "@/utils/mail-search/text-embedder";

/**
 * The browser's embedding model, run in Node for evals: the same files at
 * the same revision, on the same WebAssembly runtime, downloaded once into
 * the temp directory.
 */
export function createNodeTextEmbedder() {
  ort.env.wasm.numThreads = 1;
  return createTextEmbedder({ ort, readFile: readModelFile });
}

async function readModelFile(file: SemanticModelFile) {
  const path = join(
    tmpdir(),
    "cue-semantic-model",
    SEMANTIC_MODEL.id,
    SEMANTIC_MODEL.files[file],
  );
  try {
    return new Uint8Array(await readFile(path));
  } catch {
    const response = await fetch(semanticModelFileUrl(file));
    if (!response.ok) throw new Error(`model download ${response.status}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return bytes;
  }
}
