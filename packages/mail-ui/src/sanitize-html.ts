import DOMPurify from "dompurify";
import { linkifyMailHtml } from "./linkify";
import { isTrackingImage } from "./tracking-images";

/**
 * Sanitizes email HTML and removes tracking images from the sanitized DOM, so
 * DOMPurify's tree is the last word on the markup. `dropImage` removes other
 * images, such as the user's own open pixel, without counting them as hidden
 * trackers.
 */
export function sanitizeMailHtml(
  html: string,
  { dropImage }: { dropImage?: (src: string) => boolean } = {},
) {
  // With WHOLE_DOCUMENT, the returned node is the document's <html> element.
  const root = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    WHOLE_DOCUMENT: true,
    RETURN_DOM: true,
  }) as HTMLElement;

  let hiddenCount = 0;
  for (const image of root.querySelectorAll("img")) {
    if (dropImage?.(image.getAttribute("src")?.trim() ?? "")) {
      image.remove();
    } else if (isTrackingImage((name) => image.getAttribute(name))) {
      image.remove();
      hiddenCount += 1;
    }
  }

  linkifyMailHtml(root);
  return { html: `<!doctype html>${root.outerHTML}`, hiddenCount };
}
