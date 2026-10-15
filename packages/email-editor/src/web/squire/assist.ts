const HIGHLIGHT_NAME = "email-editor-assist";

const BLOCK_TAGS = new Set([
  "BLOCKQUOTE",
  "DIV",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "LI",
  "OL",
  "P",
  "PRE",
  "TABLE",
  "TR",
  "UL",
]);

/**
 * The draft's text as a writer sees it, one line per block and list items
 * marked as bullets, split at a range: what comes before it, what it holds
 * and what follows. The signature is left out.
 */
export function splitDraftText({
  root,
  signature,
  range,
}: {
  root: HTMLElement;
  signature: HTMLElement | null;
  range: Range;
}) {
  let text = "";
  let start = -1;
  let end = -1;
  const mark = (container: Node, offset: number) => {
    if (
      start < 0 &&
      container === range.startContainer &&
      offset === range.startOffset
    )
      start = text.length;
    if (
      end < 0 &&
      container === range.endContainer &&
      offset === range.endOffset
    )
      end = text.length;
  };
  const breakLine = () => {
    if (text && !text.endsWith("\n")) text += "\n";
  };
  const walk = (node: Node) => {
    if (node === signature) return false;
    if (node.nodeType === Node.TEXT_NODE) {
      const data = (node as Text).data;
      for (let offset = 0; offset <= data.length; offset++) {
        mark(node, offset);
        if (offset < data.length) text += data[offset];
      }
      return true;
    }
    if (!(node instanceof Element)) return true;
    if (node.nodeName === "BR") {
      text += "\n";
      return true;
    }
    const block = node !== root && BLOCK_TAGS.has(node.nodeName);
    if (block) breakLine();
    if (node.nodeName === "LI") {
      const list = node.parentElement;
      text +=
        list?.nodeName === "OL"
          ? `${[...list.children].indexOf(node) + 1}. `
          : "- ";
    }
    const children = [...node.childNodes];
    for (const [index, child] of children.entries()) {
      mark(node, index);
      if (!walk(child)) return false;
    }
    mark(node, children.length);
    // A block holding only a <br> is a blank line the <br> already ended.
    if (block && node.lastChild?.nodeName !== "BR") breakLine();
    return true;
  };
  walk(root);
  // Squire keeps spaces typed at a line's end as no-break spaces.
  const full = text.replace(/\u00a0/gu, " ").replace(/\n+$/u, "");
  const from = Math.min(Math.max(start, 0), full.length);
  const to = Math.min(Math.max(end, from), full.length);
  return {
    before: full.slice(0, from),
    text: full.slice(from, to),
    after: full.slice(to),
  };
}

/**
 * Text inserted at a caret between two words gets the spaces a person would
 * type. Squire drops ordinary spaces at a block's edges, so these are
 * no-break spaces, as Squire itself uses for a trailing space.
 */
export function joinWithSpaces(html: string, range: Range) {
  if (!range.collapsed) return html;
  const { startContainer: node, startOffset: offset } = range;
  const data = node.nodeType === Node.TEXT_NODE ? (node as Text).data : "";
  const before = data.slice(0, offset).at(-1) ?? "";
  const after = data.slice(offset)[0] ?? "";
  if (!/\S/u.test(before) && !/\S/u.test(after)) return html;

  const template = document.createElement("template");
  template.innerHTML = html;
  const walker = document.createTreeWalker(
    template.content,
    NodeFilter.SHOW_TEXT,
  );
  const texts: Text[] = [];
  for (let text = walker.nextNode(); text; text = walker.nextNode()) {
    if ((text as Text).data.trim()) texts.push(text as Text);
  }
  const first = texts[0];
  const last = texts.at(-1);
  if (!first || !last) return html;
  if (
    /\S/u.test(before) &&
    /^[\p{L}\p{N}("'“‘]/u.test(first.data.trimStart())
  ) {
    first.data = `\u00a0${first.data.trimStart()}`;
  }
  if (/[\p{L}\p{N}]/u.test(after) && /\S$/u.test(last.data)) {
    last.data = `${last.data.trimEnd()}\u00a0`;
  }
  return template.innerHTML;
}

/** Everything a person typed: the root's content, without the signature. */
export function editableContentRange(
  root: HTMLElement,
  signature: HTMLElement | null,
) {
  const range = document.createRange();
  range.selectNodeContents(root);
  if (signature && root.contains(signature)) {
    range.setEndBefore(signature);
  }
  return range;
}

// The highlight lives outside the DOM, so it never reaches the draft, its
// autosave or the undo history.
export function showAssistHighlight(range: Range | null) {
  const registry = (
    globalThis.CSS as { highlights?: Map<string, unknown> } | undefined
  )?.highlights;
  const Highlight = (
    globalThis as { Highlight?: new (...ranges: Range[]) => unknown }
  ).Highlight;
  if (!registry || !Highlight) return;
  if (range && !range.collapsed) {
    registry.set(HIGHLIGHT_NAME, new Highlight(range));
  } else {
    registry.delete(HIGHLIGHT_NAME);
  }
}
