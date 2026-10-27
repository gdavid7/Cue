import DOMPurify from "dompurify";
import { getMismatchedLinkHost } from "./link-destination";
import { linkifyMailHtml } from "./linkify";
import { isTrackingImage } from "./tracking-images";

/**
 * Sanitizes email HTML and removes tracking images from the sanitized DOM, so
 * DOMPurify's tree is the last word on the markup. `dropImage` removes other
 * images, such as the user's own open pixel, without counting them as hidden
 * trackers. Links whose text shows one address but whose href goes to another
 * get the real host as their title and are counted in `mismatchedLinkCount`.
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

  let mismatchedLinkCount = 0;
  for (const anchor of root.querySelectorAll("a[href]")) {
    const host = getMismatchedLinkHost(
      anchor.textContent ?? "",
      anchor.getAttribute("href")?.trim() ?? "",
    );
    if (!host) continue;
    anchor.setAttribute("title", host);
    mismatchedLinkCount += 1;
  }

  // Linkified anchors show their own address, so they are never mismatched.
  linkifyMailHtml(root);
  return {
    html: `<!doctype html>${root.outerHTML}`,
    hiddenCount,
    mismatchedLinkCount,
  };
}
