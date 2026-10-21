import { readFile } from "node:fs/promises";
import { join } from "node:path";
import * as ort from "onnxruntime-web/wasm";
import {
  isPinnedModelFile,
  type SemanticModelFile,
  semanticModelFilePath,
} from "@/utils/mail-search/semantic-embedding";
import { createTextEmbedder } from "@/utils/mail-search/text-embedder";

/**
 * The browser's embedding model, run in Node for evals: the same files at
 * the same revision, read from the app's public folder, on the same
 * WebAssembly runtime.
 */
export function createNodeTextEmbedder() {
  ort.env.wasm.numThreads = 1;
  return createTextEmbedder({ ort, readFile: readModelFile });
}

async function readModelFile(file: SemanticModelFile) {
  const bytes = new Uint8Array(
    await readFile(join(process.cwd(), "public", semanticModelFilePath(file))),
  );
  if (!(await isPinnedModelFile(file, bytes)))
    throw new Error(`model file ${file} does not match its pinned hash`);
  return bytes;
}
