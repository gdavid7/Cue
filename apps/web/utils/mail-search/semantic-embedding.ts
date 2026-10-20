/**
 * The on-device embedding model behind semantic search. Mail never leaves
 * the device to be embedded: the browser downloads these files once, from
 * the model's public repository at a pinned revision, and runs the model in
 * a worker. Changing any field below changes `id`, so vectors made by
 * another model are never compared with this one's.
 */
export const SEMANTIC_MODEL = {
  id: "all-MiniLM-L6-v2@q8",
  repository: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  files: {
    model: "onnx/model_quantized.onnx",
    tokenizer: "tokenizer.json",
    tokenizerConfig: "tokenizer_config.json",
  },
  dimensions: 384,
  // What the model was trained on; longer input only costs time.
  maxTokens: 128,
} as const;

export type SemanticModelFile = keyof typeof SEMANTIC_MODEL.files;

export function semanticModelFileUrl(file: SemanticModelFile) {
  return `https://huggingface.co/${SEMANTIC_MODEL.repository}/resolve/${SEMANTIC_MODEL.revision}/${SEMANTIC_MODEL.files[file]}`;
}

export type TextEmbedder = {
  /** One unit-length vector per text, in order. */
  embed(texts: string[]): Promise<Float32Array[]>;
};

/**
 * The text a message is embedded from: its subject, sender and the start of
 * its body (or its preview when the body isn't stored), as one passage.
 */
export function messageEmbeddingText({
  subject,
  from,
  body,
}: {
  subject: string;
  from: string;
  body: string;
}) {
  const sender = from
    .replace(/<[^>]*>/g, "")
    .replace(/["']/g, "")
    .trim();
  return [subject, sender, body]
    .map((part) => part.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join(". ")
    .slice(0, 1000);
}

/**
 * A unit vector as signed bytes, a quarter of its float size on disk. The
 * rounding moves a cosine by well under 0.01, far below what ranking uses.
 */
export function quantizeVector(vector: Float32Array): Int8Array {
  const bytes = new Int8Array(vector.length);
  for (let index = 0; index < vector.length; index += 1) {
    bytes[index] = Math.max(
      -127,
      Math.min(127, Math.round(vector[index] * 127)),
    );
  }
  return bytes;
}
