import { Tokenizer } from "@huggingface/tokenizers";
import type { InferenceSession, Tensor } from "onnxruntime-web";
import {
  SEMANTIC_MODEL,
  type SemanticModelFile,
  type TextEmbedder,
} from "@/utils/mail-search/semantic-embedding";

type OrtModule = {
  InferenceSession: Pick<typeof InferenceSession, "create">;
  Tensor: typeof Tensor;
};

/**
 * Loads the model into an inference session. `readFile` supplies each of the
 * model's files, from a cache or the network in the browser and from disk in
 * tests.
 */
export async function createTextEmbedder({
  ort,
  readFile,
}: {
  ort: OrtModule;
  readFile: (file: SemanticModelFile) => Promise<Uint8Array>;
}): Promise<TextEmbedder> {
  const [model, tokenizerJson, tokenizerConfig] = await Promise.all([
    readFile("model"),
    readFile("tokenizer").then(parseJson),
    readFile("tokenizerConfig").then(parseJson),
  ]);
  const tokenizer = new Tokenizer(tokenizerJson, tokenizerConfig);
  const session = await ort.InferenceSession.create(model, {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  });
  return {
    async embed(texts) {
      if (!texts.length) return [];
      const encoded = texts.map((text) => truncateIds(tokenizer, text));
      const length = Math.max(...encoded.map((ids) => ids.length));
      const size = texts.length * length;
      const inputIds = new BigInt64Array(size);
      const attentionMask = new BigInt64Array(size);
      encoded.forEach((ids, row) => {
        ids.forEach((id, column) => {
          inputIds[row * length + column] = BigInt(id);
          attentionMask[row * length + column] = BigInt(1);
        });
      });
      const dims = [texts.length, length];
      const feeds: Record<string, Tensor> = {
        input_ids: new ort.Tensor("int64", inputIds, dims),
        attention_mask: new ort.Tensor("int64", attentionMask, dims),
      };
      if (session.inputNames.includes("token_type_ids")) {
        feeds.token_type_ids = new ort.Tensor(
          "int64",
          new BigInt64Array(size),
          dims,
        );
      }
      const output = await session.run(feeds);
      const hidden = output[session.outputNames[0]];
      return meanPool(
        hidden.data as Float32Array,
        encoded.map((ids) => ids.length),
        length,
        SEMANTIC_MODEL.dimensions,
      );
    },
  };
}

function truncateIds(tokenizer: Tokenizer, text: string) {
  const { ids } = tokenizer.encode(text);
  if (ids.length <= SEMANTIC_MODEL.maxTokens) return ids;
  // Keeps the closing separator the model expects.
  return [...ids.slice(0, SEMANTIC_MODEL.maxTokens - 1), ids[ids.length - 1]];
}

function meanPool(
  hidden: Float32Array,
  lengths: number[],
  stride: number,
  dimensions: number,
) {
  return lengths.map((tokens, row) => {
    const vector = new Float32Array(dimensions);
    for (let token = 0; token < tokens; token += 1) {
      const offset = (row * stride + token) * dimensions;
      for (let dim = 0; dim < dimensions; dim += 1)
        vector[dim] += hidden[offset + dim];
    }
    let norm = 0;
    for (let dim = 0; dim < dimensions; dim += 1) {
      vector[dim] /= tokens;
      norm += vector[dim] * vector[dim];
    }
    norm = Math.sqrt(norm) || 1;
    for (let dim = 0; dim < dimensions; dim += 1) vector[dim] /= norm;
    return vector;
  });
}

function parseJson(bytes: Uint8Array): object {
  return JSON.parse(new TextDecoder().decode(bytes));
}
