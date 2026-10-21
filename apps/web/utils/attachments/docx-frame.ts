import type { HElement } from "docx-preview";

/**
 * The preview frame's document. docx-preview empties the containers it's
 * given, so it gets two of its own in the body; the head keeps the CSP. With
 * no allow-scripts on the frame nothing in it runs, and the CSP lets it load
 * nothing but embedded (data:) images and fonts, so a document can't call
 * home with a remote image, font or stylesheet.
 */
export const DOCX_FRAME_DOCUMENT = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; base-uri 'none'; form-action 'none'"><style>html,body{margin:0;background:transparent}.docx-wrapper{background:transparent!important;padding:16px!important}</style></head><body><div id="docx-styles"></div><div id="docx-body"></div></body></html>`;

export const DOCX_RENDER_OPTIONS = {
  ignoreLastRenderedPageBreak: true,
  // Embedded images as data: URLs, the only kind the frame's CSP loads.
  useBase64URL: true,
  // An altChunk is a whole HTML page embedded in the document.
  renderAltChunks: false,
  renderChanges: false,
  renderComments: false,
  // Headers and footers stay: they're the document's own content, and their
  // images go through the same data:-only factory.
  renderHeaders: true,
  renderFooters: true,
};

/**
 * Elements a Word document has no business putting in the preview. Defence in
 * depth: the frame's sandbox and CSP already stop them running or loading.
 */
const BLOCKED_TAGS = new Set(["iframe", "frame", "object", "embed", "script"]);

/**
 * docx-preview's element factory, building in the frame's own document so
 * every load is governed by the frame's CSP, never this page's; the CSP is
 * what blocks remote loads. As defence in depth an image only ever takes a
 * data: source, which also keeps the `null` docx-preview sets for a missing
 * or external part from becoming a request for "null".
 */
export function createFrameElementFactory(doc: Document) {
  const h = (elem: HElement | Node | string): Node => {
    if (typeof elem === "string") return doc.createTextNode(elem);
    if (isNode(elem)) return elem;
    const { ns, tagName, className, style, children, ...props } = elem;
    if (tagName === "#fragment") {
      const fragment = doc.createDocumentFragment();
      for (const child of children ?? []) fragment.appendChild(h(child));
      return fragment;
    }
    if (tagName === "#comment")
      return doc.createComment(
        typeof children?.[0] === "string" ? children[0] : "",
      );
    if (BLOCKED_TAGS.has(tagName.toLowerCase())) return doc.createComment("");

    const result = ns
      ? doc.createElementNS(ns, tagName)
      : doc.createElement(tagName);
    if (tagName.toLowerCase() === "img") guardImageSource(result);
    if (tagName.toLowerCase() === "image") guardImageHref(result);
    if (className) result.setAttribute("class", className);
    if (typeof style === "string") result.setAttribute("style", style);
    else if (style)
      Object.assign((result as HTMLElement | SVGElement).style, style);
    for (const [key, value] of Object.entries(props))
      if (value !== undefined)
        (result as unknown as Record<string, unknown>)[key] = value;
    for (const child of children ?? []) result.appendChild(h(child));
    return result;
  };
  return h;
}

/**
 * Keeps links from navigating the frame, which would turn the preview into a
 * page the document chose. Web and mail links open in a new tab instead;
 * in-document links scroll to their bookmark.
 */
export function handleFrameLinkClick(
  event: MouseEvent,
  open: (url: string) => void,
) {
  const target = event.target as Element | null;
  const link = target?.closest?.("a");
  if (!link) return;
  event.preventDefault();
  const href = link.getAttribute("href") ?? "";
  if (href.startsWith("#")) {
    const id = decodeBookmark(href.slice(1));
    const doc = link.ownerDocument;
    (doc.getElementById(id) ?? doc.getElementsByName(id)[0])?.scrollIntoView();
    return;
  }
  const url = parseExternalUrl(href);
  if (url) open(url);
}

function decodeBookmark(id: string) {
  try {
    return decodeURIComponent(id);
  } catch {
    // A malformed escape like "%E0%A4%A"; look the name up as written.
    return id;
  }
}

function parseExternalUrl(href: string) {
  try {
    const url = new URL(href);
    return ["http:", "https:", "mailto:"].includes(url.protocol)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function guardImageSource(img: Element) {
  Object.defineProperty(img, "src", {
    configurable: true,
    get: () => img.getAttribute("src") ?? "",
    set: (value: unknown) => {
      if (isDataUrl(value)) img.setAttribute("src", value);
    },
  });
}

function guardImageHref(image: Element) {
  const setAttribute = image.setAttribute.bind(image);
  image.setAttribute = (name: string, value: string) => {
    if (/(^|:)href$/i.test(name) && !isDataUrl(value)) return;
    setAttribute(name, value);
  };
}

function isDataUrl(value: unknown): value is string {
  return typeof value === "string" && value.startsWith("data:");
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" &&
    value !== null &&
    "nodeType" in value &&
    typeof (value as Node).nodeType === "number"
  );
}
