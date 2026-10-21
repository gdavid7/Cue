import {
  findPlaceholderMatches,
  normalizeForScan,
  PLACEHOLDER_IGNORED_SELECTOR,
} from "./find-placeholders";

/**
 * Selects the first place `placeholder` stands as a placeholder inside an
 * editable element, so the next keystroke replaces it. Reads each text node the
 * way the check did, so it lands on the same one. Text split across formatting
 * is left unselected.
 */
export function selectPlaceholderIn(root: HTMLElement, placeholder: string) {
  const target = normalizeForScan(placeholder);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(PLACEHOLDER_IGNORED_SELECTOR)) continue;
    const original = node.nodeValue ?? "";
    const text = original.replace(/ /g, " ").normalize("NFC");
    const match = findPlaceholderMatches(text).find(
      (found) => found.text === target,
    );
    if (!match) continue;
    const range = document.createRange();
    range.setStart(node, originalOffset(original, match.index, "start"));
    range.setEnd(
      node,
      originalOffset(original, match.index + target.length, "end"),
    );
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
}

// Normalising can shorten the text, so an offset in it is found in the
// original: a start is after any accent that was folded into the character
// before it, an end is as soon as the normalised text reaches it.
function originalOffset(
  original: string,
  normalizedOffset: number,
  edge: "start" | "end",
) {
  let low = 0;
  let high = original.length;
  while (low < high) {
    const mid = (low + high + (edge === "start" ? 1 : 0)) >> 1;
    const length = normalizeForScan(original.slice(0, mid)).length;
    if (edge === "start") {
      if (length <= normalizedOffset) low = mid;
      else high = mid - 1;
    } else if (length < normalizedOffset) low = mid + 1;
    else high = mid;
  }
  return low;
}
