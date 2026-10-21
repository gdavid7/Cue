import { findPlaceholderMatches } from "./find-placeholders";

// What the detector leaves out of the message, so it never selects there.
const NOT_CHECKED = "pre, code, blockquote, .gmail_quote, a";

/**
 * Selects the first place `placeholder` stands as a placeholder inside an
 * editable element, so the next keystroke replaces it. Reads each text node the
 * way the check did, so it lands on the same one. Text split across formatting
 * is left unselected.
 */
export function selectPlaceholderIn(root: HTMLElement, placeholder: string) {
  const target = placeholder.normalize("NFC");
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (node.parentElement?.closest(NOT_CHECKED)) continue;
    const original = node.nodeValue ?? "";
    const text = original.replace(/ /g, " ").normalize("NFC");
    const match = findPlaceholderMatches(text).find(
      (found) => found.text === target,
    );
    if (!match) continue;
    const range = document.createRange();
    range.setStart(node, originalOffset(original, match.index));
    range.setEnd(node, originalOffset(original, match.index + target.length));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    return true;
  }
  return false;
}

// Normalising can shorten the text, so an offset in it is found in the
// original as the first point whose normalised start is that long.
function originalOffset(original: string, normalizedOffset: number) {
  let low = 0;
  let high = original.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    const length = original
      .slice(0, mid)
      .replace(/ /g, " ")
      .normalize("NFC").length;
    if (length < normalizedOffset) low = mid + 1;
    else high = mid;
  }
  return low;
}
