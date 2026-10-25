import DOMPurify from "dompurify";
import { linkifyMailHtml } from "./linkify";

export function sanitizeMailHtml(html: string) {
  // With WHOLE_DOCUMENT, the returned node is the document's <html> element.
  const root = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
  }) as HTMLElement;
  linkifyMailHtml(root);
  return `<!doctype html>${root.outerHTML}`;
}
