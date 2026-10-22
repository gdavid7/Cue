import { describe, expect, it } from "vitest";
import { SEMANTIC_MODEL } from "@/utils/mail-search/semantic-embedding";
import { createTextEmbedder } from "@/utils/mail-search/text-embedder";

const VOCAB = ["[CLS]", "[SEP]", "[UNK]", "kitchen", "invoice", "remodel"];

describe("createTextEmbedder", () => {
  it("embeds a text the same alone or beside a longer one, as a unit vector", async () => {
    const { embedder } = await fakeEmbedder();
    const [alone] = await embedder.embed(["kitchen"]);
    const [padded, longer] = await embedder.embed([
      "kitchen",
      "kitchen remodel invoice",
    ]);
    expect([...padded]).toEqual([...alone]);
    expect(norm(alone)).toBeCloseTo(1, 5);
    expect(norm(longer)).toBeCloseTo(1, 5);
    expect([...longer]).not.toEqual([...alone]);
  });

  it("cuts long text to what the model reads, keeping the closing separator", async () => {
    const { embedder, runs } = await fakeEmbedder();
    await embedder.embed([new Array(400).fill("kitchen").join(" ")]);
    const ids = [...(runs[0].input_ids.data as BigInt64Array)].map(Number);
    expect(ids).toHaveLength(SEMANTIC_MODEL.maxTokens);
    expect(ids[0]).toBe(0);
    expect(ids.at(-1)).toBe(1);
  });
});

// A word-level tokenizer and a model whose token states are one-hot by id,
// so the pooled vector shows exactly which tokens were averaged.
async function fakeEmbedder() {
  const runs: Record<string, { data: unknown; dims: readonly number[] }>[] = [];
  const dimensions = SEMANTIC_MODEL.dimensions;
  class Tensor {
    readonly data: unknown;
    readonly dims: readonly number[];
    constructor(_type: string, data: unknown, dims: readonly number[]) {
      this.data = data;
      this.dims = dims;
    }
  }
  const session = {
    inputNames: ["input_ids", "attention_mask", "token_type_ids"],
    outputNames: ["last_hidden_state"],
    async run(feeds: Record<string, Tensor>) {
      runs.push(feeds);
      const [batch, length] = feeds.input_ids.dims;
      const ids = feeds.input_ids.data as BigInt64Array;
      const hidden = new Float32Array(batch * length * dimensions);
      ids.forEach((id, position) => {
        hidden[position * dimensions + Number(id)] = 1;
      });
      return { last_hidden_state: { data: hidden } };
    },
  };
  const ort = {
    InferenceSession: { create: async () => session },
    Tensor,
  };
  const embedder = await createTextEmbedder({
    ort: ort as never,
    readFile: async (file) =>
      new TextEncoder().encode(
        JSON.stringify(file === "tokenizer" ? TOKENIZER : TOKENIZER_CONFIG),
      ),
  });
  return { embedder, runs };
}

function norm(vector: Float32Array) {
  return Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
}

const TOKENIZER = {
  version: "1.0",
  truncation: null,
  padding: null,
  added_tokens: VOCAB.slice(0, 3).map((content, id) => ({
    id,
    content,
    single_word: false,
    lstrip: false,
    rstrip: false,
    normalized: false,
    special: true,
  })),
  normalizer: null,
  pre_tokenizer: { type: "Whitespace" },
  post_processor: {
    type: "TemplateProcessing",
    single: [
      { SpecialToken: { id: "[CLS]", type_id: 0 } },
      { Sequence: { id: "A", type_id: 0 } },
      { SpecialToken: { id: "[SEP]", type_id: 0 } },
    ],
    pair: [
      { SpecialToken: { id: "[CLS]", type_id: 0 } },
      { Sequence: { id: "A", type_id: 0 } },
      { SpecialToken: { id: "[SEP]", type_id: 0 } },
      { Sequence: { id: "B", type_id: 1 } },
      { SpecialToken: { id: "[SEP]", type_id: 1 } },
    ],
    special_tokens: {
      "[CLS]": { id: "[CLS]", ids: [0], tokens: ["[CLS]"] },
      "[SEP]": { id: "[SEP]", ids: [1], tokens: ["[SEP]"] },
    },
  },
  decoder: null,
  model: {
    type: "WordLevel",
    vocab: Object.fromEntries(VOCAB.map((token, id) => [token, id])),
    unk_token: "[UNK]",
  },
};

const TOKENIZER_CONFIG = {
  cls_token: "[CLS]",
  sep_token: "[SEP]",
  unk_token: "[UNK]",
  model_max_length: 512,
};
