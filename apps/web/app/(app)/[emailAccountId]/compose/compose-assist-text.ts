export type DiffPart = { kind: "same" | "removed" | "added"; text: string };

// Past this many word pairs a diff costs more than it shows; the whole
// passage reads as replaced instead.
const MAX_DIFF_CELLS = 250_000;

/**
 * Word-level changes from one text to another, so a rewrite shows what it
 * changed rather than a wall of new text.
 */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokenize(before);
  const b = tokenize(after);
  if (a.length * b.length > MAX_DIFF_CELLS) {
    return mergeParts([
      { kind: "removed", text: before },
      { kind: "added", text: after },
    ]);
  }

  // Longest common subsequence, filled from the end so the walk below can
  // go forwards.
  const lengths = Array.from(
    { length: a.length + 1 },
    () => new Uint32Array(b.length + 1),
  );
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lengths[i][j] =
        a[i] === b[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      parts.push({ kind: "same", text: a[i] });
      i++;
      j++;
    } else if (
      j < b.length &&
      (i === a.length || lengths[i][j + 1] >= lengths[i + 1][j])
    ) {
      parts.push({ kind: "added", text: b[j] });
      j++;
    } else {
      parts.push({ kind: "removed", text: a[i] });
      i++;
    }
  }
  return mergeParts(parts);
}

/**
 * Whether a draft reads as notes to expand rather than prose: several short
 * lines, mostly bullets or fragments without closing punctuation.
 */
export function looksLikeNotes(text: string) {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) return false;
  const noteLines = lines.filter(
    (line) =>
      /^(?:[-*•–]|\d{1,2}[.)])\s/u.test(line) ||
      (line.split(/\s+/u).length <= 8 && !/[.!?,:;。！？、]$/u.test(line)),
  );
  return noteLines.length / lines.length >= 0.6;
}

function tokenize(text: string) {
  return text.match(/\s+|[^\s]+/gu) ?? [];
}

// A run of changes reads as one: everything it removed, then everything it
// added. A space alone between two changes belongs to the run.
function mergeParts(parts: DiffPart[]) {
  const merged: DiffPart[] = [];
  let removed = "";
  let added = "";
  const flush = () => {
    if (removed) merged.push({ kind: "removed", text: removed });
    if (added) merged.push({ kind: "added", text: added });
    removed = "";
    added = "";
  };
  parts.forEach((part, index) => {
    if (!part.text) return;
    const bridgesChanges =
      part.kind === "same" &&
      !part.text.trim() &&
      (removed || added) &&
      parts[index + 1] &&
      parts[index + 1].kind !== "same";
    if (part.kind === "removed" || bridgesChanges) removed += part.text;
    if (part.kind === "added" || bridgesChanges) added += part.text;
    if (part.kind !== "same" || bridgesChanges) return;
    flush();
    const last = merged.at(-1);
    if (last?.kind === "same") last.text += part.text;
    else merged.push({ ...part });
  });
  flush();
  return merged;
}
