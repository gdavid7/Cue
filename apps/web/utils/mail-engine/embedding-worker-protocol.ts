// Shared by the embedding worker and its client. It must stay apart from
// the client, which starts the worker: the worker importing that module
// would make its own chunk a dependency of itself.

/**
 * The model couldn't be kept on this device, as when storage is full: it
 * would download again on every pass, so semantic search stops for the
 * session.
 */
export const MODEL_NOT_CACHED = "model_not_cached";

/** A downloaded model file didn't match its pinned SHA-256. */
export const MODEL_INTEGRITY = "model_integrity";

export type EmbeddingWorkerRequest = { id: number; texts: string[] };
export type EmbeddingWorkerResponse =
  | { id: number; vectors: Float32Array[] }
  | { id: number; error: string };
