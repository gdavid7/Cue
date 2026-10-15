import type Squire from "squire-rte";
import {
  isSafeEmailUrl,
  SIGNATURE_CONTAINER_ATTRIBUTE,
} from "../../core/email-profile";
import { EMAIL_ELEMENT_STYLES } from "../../core/email-styles";
import { normalizeLinkHref } from "../link-panel";

type MarkdownSquire = Squire & { saveEditUndoState: () => void };

type TextPosition = { node: Text; offset: number };

// Typed into code, the signature or someone else's quoted message, markdown
// characters are content.
const EXCLUDED_CONTAINERS = `pre, code, [${SIGNATURE_CONTAINER_ATTRIBUTE}], blockquote[type="cite"]`;
const BLOCK_ELEMENTS = /^(?:BLOCKQUOTE|DD|DIV|DT|H[1-6]|LI|P|PRE|TD|TH)$/u;

// Squire leaves zero-width spaces where it parked the caret.
const BLOCK_MARKER = /^\u200b*(-|>|#{1,3}) $/u;
const RULE = "---";
const FENCE = /^```[\w+#.-]*$/u;

// A marker that opens inside a word ("2*3*4", "snake_case_name") is not
// emphasis, and markdown content never starts or ends with a space.
const INLINE_RULES = [
  {
    pattern: /(?:^|[^\p{L}\p{N}*\\])(\*\*)([^*\s](?:[^*]*[^*\s])?)\*\*$/u,
    tag: "B",
  },
  {
    pattern: /(?:^|[^\p{L}\p{N}*\\])(\*)([^*\s](?:[^*]*[^*\s])?)\*$/u,
    tag: "I",
  },
  {
    pattern: /(?:^|[^\p{L}\p{N}_\\])(_)([^_\s](?:[^_]*[^_\s])?)_$/u,
    tag: "I",
  },
  { pattern: /(?:^|[^`\\])(`)([^`]*[^`\s][^`]*)`$/u, tag: "CODE" },
  {
    pattern: /(?:^|[^~\\])(~~)([^~\s](?:[^~]*[^~\s])?)~~$/u,
    tag: "S",
  },
];
const LINK = /\[([^\]\n]*[^\]\s][^\]\n]*)\]\(([^()\s]+)\)$/u;
const INLINE_TRIGGERS = new Set(["*", "_", "`", "~", ")"]);

/**
 * Turns markdown typed into the composer into formatting: block markers at
 * the start of a line, inline markers when their closing character is typed.
 * Each conversion is its own undo step, so undo, or Backspace straight after,
 * brings the typed characters back.
 */
export function attachMarkdownShortcuts(editor: MarkdownSquire) {
  const root = editor.getRoot();
  // The caret right after a conversion, while Backspace would still undo it.
  let revertible: { node: Node; offset: number } | null = null;
  let composing = false;

  const converted = () => {
    const caret = editor.getSelection();
    revertible = { node: caret.startContainer, offset: caret.startOffset };
  };

  const onInput = (event: Event) => {
    revertible = null;
    if (
      composing ||
      !(event instanceof InputEvent) ||
      event.isComposing ||
      event.inputType !== "insertText" ||
      !event.data
    ) {
      return;
    }
    const typed = event.data.slice(-1);
    const done =
      typed === " "
        ? convertBlockMarker(editor)
        : INLINE_TRIGGERS.has(typed) && convertInlineMarkers(editor, typed);
    if (done) converted();
  };
  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
  };

  const defaultEnter = editor._keyHandlers.Enter;
  editor.setKeyHandler("Enter", (self, event, range) => {
    if (!composing && convertRuleOrFence(editor)) {
      event.preventDefault();
      converted();
      return;
    }
    defaultEnter?.(self, event, range);
  });
  const defaultBackspace = editor._keyHandlers.Backspace;
  editor.setKeyHandler("Backspace", (self, event, range) => {
    const revert = revertible;
    revertible = null;
    if (
      revert &&
      range.collapsed &&
      range.startContainer === revert.node &&
      range.startOffset === revert.offset
    ) {
      event.preventDefault();
      self.undo();
      return;
    }
    defaultBackspace?.(self, event, range);
  });

  root.addEventListener("input", onInput);
  root.addEventListener("compositionstart", onCompositionStart);
  root.addEventListener("compositionend", onCompositionEnd);
  return () => {
    root.removeEventListener("input", onInput);
    root.removeEventListener("compositionstart", onCompositionStart);
    root.removeEventListener("compositionend", onCompositionEnd);
  };
}

/** "- ", "> ", "# " to "### " typed at the start of a line. */
function convertBlockMarker(editor: MarkdownSquire) {
  const context = caretContext(editor);
  if (!context || !/^(?:DIV|P)$/u.test(context.block.nodeName)) return false;
  const marker = BLOCK_MARKER.exec(
    textBefore(context.block, context.caret).text,
  )?.[1];
  if (!marker) return false;
  // A list can't hold another list item's marker as a new list.
  if (marker === "-" && closestWithin(context.block, "li", editor)) {
    return false;
  }

  editor.saveEditUndoState();
  const caret = editor.getSelection();
  const { positions } = textBefore(context.block, caret);
  rangeOf(positions, caret, 0, positions.length).deleteContents();
  const start = document.createRange();
  start.setStart(context.block, 0);
  editor.setSelection(start);

  if (marker === "-") {
    editor.makeUnorderedList();
  } else if (marker === ">") {
    editor.increaseQuoteLevel();
  } else {
    const heading = document.createElement(`H${marker.length}`);
    heading.setAttribute("style", EMAIL_ELEMENT_STYLES[`h${marker.length}`]);
    const direction = context.block.getAttribute("dir");
    if (direction) heading.setAttribute("dir", direction);
    heading.append(...context.block.childNodes);
    if (!heading.textContent) heading.append(document.createElement("BR"));
    context.block.replaceWith(heading);
    const caretInHeading = document.createRange();
    caretInHeading.setStart(heading, 0);
    editor.setSelection(caretInHeading);
  }
  return true;
}

/** "---" or "```" alone on a line, confirmed with Enter. */
function convertRuleOrFence(editor: MarkdownSquire) {
  const context = caretContext(editor);
  if (!context || !/^(?:DIV|P)$/u.test(context.block.nodeName)) return false;
  const { block, caret } = context;
  const before = textBefore(block, caret).text;
  const whole = cleanText(block.textContent ?? "").replace(/\u200b/gu, "");
  if (
    before.replace(/\u200b/gu, "") !== whole ||
    (whole !== RULE && !FENCE.test(whole))
  ) {
    return false;
  }

  editor.saveEditUndoState();
  if (whole === RULE) {
    const next = editor.createDefaultBlock();
    block.replaceWith(
      editor.createDefaultBlock([document.createElement("HR")]),
      next,
    );
    const caretBelow = document.createRange();
    caretBelow.setStart(next, 0);
    editor.setSelection(caretBelow);
  } else {
    block.replaceChildren(document.createElement("BR"));
    const caretInBlock = document.createRange();
    caretInBlock.setStart(block, 0);
    editor.setSelection(caretInBlock);
    editor.code();
  }
  return true;
}

/** "**bold**", "*italic*", "_italic_", "`code`", "~~strike~~", "[label](url)". */
function convertInlineMarkers(editor: MarkdownSquire, typed: string) {
  const context = caretContext(editor);
  if (!context) return false;
  const { text } = textBefore(context.block, context.caret);
  const match = typed === ")" ? matchLink(text) : matchFormat(text);
  if (!match) return false;

  editor.saveEditUndoState();
  // Saving the undo step can merge text nodes, so map the text again.
  const caret = editor.getSelection();
  const { positions } = textBefore(context.block, caret);
  const end = positions.length;
  const content = rangeOf(
    positions,
    caret,
    match.contentStart,
    match.contentEnd,
  );
  const closing = rangeOf(positions, caret, match.contentEnd, end);
  const opening = rangeOf(positions, caret, match.start, match.contentStart);
  closing.deleteContents();
  opening.deleteContents();

  let tag: string;
  if (match.kind === "link") {
    tag = "A";
    editor.setSelection(content);
    editor.makeLink(match.href);
  } else {
    tag = match.tag;
    editor.changeFormat(
      {
        tag,
        attributes:
          tag === "CODE" ? { style: EMAIL_ELEMENT_STYLES.code } : undefined,
      },
      null,
      content,
    );
  }
  // Text typed next continues unformatted, after the new element.
  const after = editor.getSelection();
  after.collapse(false);
  editor.changeFormat(null, { tag }, after);
  return true;
}

function matchFormat(text: string) {
  for (const { pattern, tag } of INLINE_RULES) {
    const match = pattern.exec(text);
    if (!match) continue;
    const [, marker, content] = match;
    const start = text.length - marker.length * 2 - content.length;
    return {
      contentEnd: text.length - marker.length,
      contentStart: start + marker.length,
      kind: "format" as const,
      start,
      tag,
    };
  }
  return null;
}

function matchLink(text: string) {
  const match = LINK.exec(text);
  if (!match) return null;
  // "[a](b)" in prose is an aside, not a link: only something that reads as
  // an address (a scheme, a domain or an email address) becomes one.
  const target = match[2].trim();
  if (!/^[a-z][a-z\d+.-]*:|\.|@/iu.test(target)) return null;
  const href = normalizeLinkHref(target);
  if (!href || !isSafeEmailUrl(href)) return null;
  const start = text.length - match[0].length;
  return {
    contentEnd: start + 1 + match[1].length,
    contentStart: start + 1,
    href,
    kind: "link" as const,
    start,
  };
}

function caretContext(editor: Squire) {
  const root = editor.getRoot();
  const caret = editor.getSelection();
  if (!caret.collapsed || !root.contains(caret.startContainer)) return null;
  if (closestWithin(caret.startContainer, EXCLUDED_CONTAINERS, editor)) {
    return null;
  }
  let node: Node | null = caret.startContainer;
  while (node && node !== root) {
    if (node instanceof Element && BLOCK_ELEMENTS.test(node.nodeName)) {
      return { block: node, caret };
    }
    node = node.parentNode;
  }
  return null;
}

// The block's text up to the caret, with the text node and offset each
// character came from.
function textBefore(block: Element, caret: Range) {
  const positions: TextPosition[] = [];
  let text = "";
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (
    let node = walker.nextNode() as Text | null;
    node;
    node = walker.nextNode() as Text | null
  ) {
    const isCaretNode = node === caret.startContainer;
    if (!isCaretNode && caret.comparePoint(node, 0) > 0) break;
    const end = isCaretNode ? caret.startOffset : node.length;
    for (let offset = 0; offset < end; offset += 1) {
      positions.push({ node, offset });
    }
    text += node.data.slice(0, end);
    if (isCaretNode) break;
  }
  return { positions, text: cleanText(text) };
}

function rangeOf(
  positions: TextPosition[],
  caret: Range,
  start: number,
  end: number,
) {
  const range = document.createRange();
  const from = positions[start];
  if (from) range.setStart(from.node, from.offset);
  else range.setStart(caret.startContainer, caret.startOffset);
  const to = positions[end];
  if (to) range.setEnd(to.node, to.offset);
  else range.setEnd(caret.startContainer, caret.startOffset);
  return range;
}

// Same length as the input, so character offsets still line up.
function cleanText(text: string) {
  return text.replace(/\u00a0/gu, " ");
}

function closestWithin(node: Node, selector: string, editor: Squire) {
  const element = node instanceof Element ? node : node.parentElement;
  const match = element?.closest(selector);
  return match && editor.getRoot().contains(match) ? match : null;
}
