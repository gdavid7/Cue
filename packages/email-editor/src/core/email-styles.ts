import { parseFragment, serialize, type DefaultTreeAdapterTypes } from "parse5";

type ChildNode = DefaultTreeAdapterTypes.ChildNode;
type Element = DefaultTreeAdapterTypes.Element;
type ParentNode = DefaultTreeAdapterTypes.ParentNode;

const MONOSPACE_FONT =
  "font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace";

// Mail clients drop <style> blocks, so structure created in the composer
// carries its look inline. Every property here is inside the body profile's
// style allowlist. Nothing sets a background or text color: dark-mode clients
// invert fills and would turn a light code box into a glaring one.
export const EMAIL_ELEMENT_STYLES: Record<string, string> = {
  blockquote: "margin:0 0 0 0.8ex;border-left:2px solid #ccc;padding-left:1ex",
  code: `${MONOSPACE_FONT};font-size:0.9em;border:1px solid #ccc;border-radius:3px;padding:0 3px`,
  h1: "font-size:24px;line-height:1.25;margin:16px 0 8px",
  h2: "font-size:20px;line-height:1.3;margin:14px 0 6px",
  h3: "font-size:17px;line-height:1.35;margin:12px 0 4px",
  h4: "font-size:15px;line-height:1.4;margin:12px 0 4px",
  h5: "font-size:14px;line-height:1.4;margin:12px 0 4px",
  h6: "font-size:13px;line-height:1.4;margin:12px 0 4px",
  pre: `${MONOSPACE_FONT};font-size:0.9em;white-space:pre-wrap;border:1px solid #ccc;border-radius:3px;padding:8px;margin:8px 0`,
  table: "border-collapse:collapse",
};

const TABLE_ATTRIBUTES = { border: "1", cellpadding: "6" };

// Whitespace between these elements' children is source formatting, not text.
const LAYOUT_CONTAINERS = new Set([
  "blockquote",
  "ol",
  "table",
  "tbody",
  "tfoot",
  "thead",
  "tr",
  "ul",
]);

/**
 * Gives headings, quotes, code and tables the inline styles they need to look
 * the same in every mail client. Styles already on an element win, so running
 * it twice changes nothing.
 */
export function toEmailStyledHtml(html: string) {
  const fragment = parseFragment(html);
  removeLayoutWhitespace(fragment, true);
  styleElements(fragment, false);
  return serialize(fragment);
}

function styleElements(parent: ParentNode, inPre: boolean) {
  for (const node of [...parent.childNodes]) {
    if (!isElement(node)) continue;
    styleElements(node, inPre || node.tagName === "pre");
    // A code block's <code> is only a marker; the <pre> is the box.
    if (inPre && node.tagName === "code") {
      unwrap(node);
      continue;
    }
    const style = EMAIL_ELEMENT_STYLES[node.tagName];
    if (style) mergeStyle(node, style);
    if (node.tagName !== "table") continue;
    for (const [name, value] of Object.entries(TABLE_ATTRIBUTES)) {
      if (getAttribute(node, name) === undefined) {
        node.attrs.push({ name, value });
      }
    }
  }
}

function mergeStyle(element: Element, style: string) {
  const existing = getAttribute(element, "style")?.trim() ?? "";
  const present = new Set(
    existing
      .split(";")
      .map((declaration) =>
        declaration.slice(0, declaration.indexOf(":")).trim().toLowerCase(),
      )
      .filter(Boolean),
  );
  const added = style
    .split(";")
    .filter((declaration) => !present.has(declaration.split(":")[0]));
  if (!added.length) return;
  const value = [existing.replace(/;\s*$/u, ""), ...added]
    .filter(Boolean)
    .join(";");
  const attribute = element.attrs.find(({ name }) => name === "style");
  if (attribute) attribute.value = value;
  else element.attrs.push({ name: "style", value });
}

function removeLayoutWhitespace(parent: ParentNode, isRoot: boolean) {
  const layout =
    isRoot || (isElement(parent) && LAYOUT_CONTAINERS.has(parent.tagName));
  parent.childNodes = parent.childNodes.filter(
    (node) =>
      !(
        layout &&
        node.nodeName === "#text" &&
        !(node as DefaultTreeAdapterTypes.TextNode).value.trim()
      ),
  );
  for (const node of parent.childNodes) {
    if (isElement(node) && node.tagName !== "pre") {
      removeLayoutWhitespace(node, false);
    }
  }
}

function unwrap(element: Element) {
  const parent = element.parentNode;
  if (!parent) return;
  const index = parent.childNodes.indexOf(element);
  for (const child of element.childNodes) child.parentNode = parent;
  parent.childNodes.splice(index, 1, ...element.childNodes);
}

function getAttribute(element: Element, name: string) {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}

function isElement(node: ChildNode | ParentNode): node is Element {
  return "tagName" in node;
}
