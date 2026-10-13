// TF-IDF cosine similarity: a cheap, deterministic stand-in for embeddings.
// Rare words that two texts share count for more than common ones.

const STOP = new Set(
  "a an the and or but if of to in on at for from by with is are was were be been it its this that these those you your we our i me my he she they them his her their as so do does did can could would should will just not no yes have has had am pm hi hello hey thanks thank please re fw fwd let know get got also us any all one".split(
    " ",
  ),
);

// Letters and digits in any script, so non-English mail works too. Everything
// else, including search operators like ":" "-" and quotes, becomes a space.
export function tokenize(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}$%\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 2 && !STOP.has(t));
}

export class Corpus {
  private readonly df = new Map<string, number>();
  private readonly n: number;

  constructor(texts: string[]) {
    this.n = texts.length;
    for (const text of texts) {
      for (const t of new Set(tokenize(text))) {
        this.df.set(t, (this.df.get(t) ?? 0) + 1);
      }
    }
  }

  idf(term: string): number {
    return Math.log(1 + (this.n + 1) / ((this.df.get(term) ?? 0) + 1));
  }

  vector(text: string): Map<string, number> {
    const v = new Map<string, number>();
    for (const t of tokenize(text)) v.set(t, (v.get(t) ?? 0) + 1);
    for (const [t, f] of v) v.set(t, f * this.idf(t));
    return v;
  }

  /** Cosine similarity in [0, 1], plus the shared terms that drove it, strongest first. */
  similarity(a: string, b: string): { score: number; terms: string[] } {
    const va = this.vector(a);
    const vb = this.vector(b);
    let dot = 0;
    const shared: [string, number][] = [];
    for (const [t, w] of va) {
      const other = vb.get(t);
      if (!other) continue;
      dot += w * other;
      shared.push([t, w * other]);
    }
    const denom = norm(va) * norm(vb);
    shared.sort((x, y) => y[1] - x[1]);
    return {
      score: denom === 0 ? 0 : dot / denom,
      terms: shared.map(([t]) => t),
    };
  }
}

function norm(v: Map<string, number>) {
  let s = 0;
  for (const w of v.values()) s += w * w;
  return Math.sqrt(s);
}
