/**
 * The on-device embedding model behind semantic search. Mail never leaves
 * the device to be embedded: the browser downloads these files once, from
 * Cue's own origin, and runs the model in a worker. They are the model
 * repository's files at a pinned revision, committed under `public/models`
 * so no third party sees who uses semantic search. Changing any field below
 * changes `id`, so vectors made by another model are never compared with
 * this one's.
 */
export const SEMANTIC_MODEL = {
  id: "all-MiniLM-L6-v2@q8",
  repository: "Xenova/all-MiniLM-L6-v2",
  revision: "751bff37182d3f1213fa05d7196b954e230abad9",
  // Each file's SHA-256, checked before it is used or cached.
  files: {
    model: {
      path: "onnx/model_quantized.onnx",
      sha256:
        "afdb6f1a0e45b715d0bb9b11772f032c399babd23bfc31fed1c170afc848bdb1",
    },
    tokenizer: {
      path: "tokenizer.json",
      sha256:
        "da0e79933b9ed51798a3ae27893d3c5fa4a201126cef75586296df9b4d2c62a0",
    },
    tokenizerConfig: {
      path: "tokenizer_config.json",
      sha256:
        "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
    },
  },
  dimensions: 384,
  // What the model was trained on; longer input only costs time.
  maxTokens: 128,
} as const;

export type SemanticModelFile = keyof typeof SEMANTIC_MODEL.files;

/** Where the app serves a model file, under `public/`. */
export function semanticModelFilePath(file: SemanticModelFile) {
  return `/models/${SEMANTIC_MODEL.repository}/${SEMANTIC_MODEL.revision}/${SEMANTIC_MODEL.files[file].path}`;
}

/** Whether `bytes` are the pinned file, by SHA-256. */
export async function isPinnedModelFile(
  file: SemanticModelFile,
  bytes: Uint8Array,
) {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>),
  );
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return hex === SEMANTIC_MODEL.files[file].sha256;
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
