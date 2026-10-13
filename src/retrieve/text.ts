// Tiny text-similarity toolkit: tokenization + TF-IDF cosine similarity.
//
// This stands in for embeddings so the demo runs offline and deterministically.
// The retrieval code only depends on `similarity(query, doc)`, so swapping in a
// real embedding model later is a one-function change.

const STOP = new Set(
  "a an the and or but if of to in on at for from by with is are was were be been it its this that these those you your we our i me my he she they them his her their as so do does did can could would should will just not no yes have has had am pm hi hello thanks thank please".split(" "),
);

// Normalize a few abbreviations so "Wed" and "Wednesday" match.
const ALIASES: Record<string, string> = {
  mon: "monday", tue: "tuesday", tues: "tuesday", wed: "wednesday", thu: "thursday", thurs: "thursday",
  fri: "friday", sat: "saturday", sun: "sunday", flying: "flight", flights: "flight", forms: "form",
};

export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9$%.\s]/g, " ")
    .split(/\s+/)
    .map((t) => t.replace(/^\.+|\.+$/g, ""))
    .filter((t) => t.length > 1 && !STOP.has(t))
    .map((t) => ALIASES[t] ?? t);
}

export class Corpus {
  private df = new Map<string, number>();
  private n = 0;

  add(text: string) {
    this.n++;
    for (const t of new Set(tokenize(text))) this.df.set(t, (this.df.get(t) ?? 0) + 1);
  }

  /** Inverse document frequency: rare words count more than common ones. */
  idf(term: string): number {
    return Math.log(1 + (this.n + 1) / ((this.df.get(term) ?? 0) + 1));
  }

  vector(text: string): Map<string, number> {
    const tf = new Map<string, number>();
    for (const t of tokenize(text)) tf.set(t, (tf.get(t) ?? 0) + 1);
    for (const [t, f] of tf) tf.set(t, f * this.idf(t));
    return tf;
  }

  /** Cosine similarity between TF-IDF vectors, in [0, 1]. */
  similarity(a: string, b: string): number {
    const va = this.vector(a);
    const vb = this.vector(b);
    let dot = 0;
    for (const [t, w] of va) dot += w * (vb.get(t) ?? 0);
    const norm = (v: Map<string, number>) => Math.sqrt([...v.values()].reduce((s, w) => s + w * w, 0));
    const denom = norm(va) * norm(vb);
    return denom === 0 ? 0 : dot / denom;
  }
}
