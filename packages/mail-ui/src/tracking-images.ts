// Matches a whole <img> tag, skipping a ">" inside a quoted attribute value.
const IMG_TAG = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const ATTRIBUTE =
  /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
const PIXEL_LENGTH = /^\s*(\d+(?:\.\d+)?)\s*(?:px)?\s*$/i;
const ZERO_LENGTH = /^\s*0+(?:\.0+)?\s*(?:[a-z%]+)?\s*$/i;

// Hosts that serve nothing but open-tracking images.
const TRACKER_HOSTS = [
  "awstrack.me",
  "mailfoogae.appspot.com",
  "mailtrack.io",
  "pstmrk.it",
  "r.superhuman.com",
  "t.yesware.com",
];

// Open-tracking paths of common sending platforms, which often run on the
// sender's own domain.
const TRACKER_PATHS = [
  /\/track\/open(?:\.php)?$/i, // Mailchimp, Mandrill
  /^\/wf\/open$/i, // SendGrid
  /\/open\.aspx$/i, // Salesforce Marketing Cloud
];

/**
 * Removes remote images whose only purpose is to tell the sender the email
 * was opened: images sized 1x1 or smaller, hidden images, and images from
 * known open-tracking hosts. Small visible images, such as icons and dividers,
 * are kept. Works on a string so the reader and the image-proxy rewrite apply
 * the same rule.
 */
export function stripTrackingImages(html: string) {
  if (!html) return { html, hiddenCount: 0 };
  let hiddenCount = 0;
  const stripped = html.replace(IMG_TAG, (tag) => {
    if (!isTrackingImage(parseAttributes(tag))) return tag;
    hiddenCount += 1;
    return "";
  });
  return { html: hiddenCount ? stripped : html, hiddenCount };
}

function isTrackingImage(attributes: Map<string, string>) {
  const src = attributes.get("src")?.trim().replace(/&amp;/gi, "&");
  if (!src) return false;
  const url = parseRemoteUrl(src);
  if (!url) return false;
  if (isKnownTrackerUrl(url)) return true;

  const style = parseStyle(attributes.get("style") ?? "");
  const width = readLength(style.get("width") ?? attributes.get("width"));
  const height = readLength(style.get("height") ?? attributes.get("height"));

  // A declared size larger than a pixel means the image is meant to be seen,
  // even when it starts hidden (a mobile-only hero shown by a media query).
  if ((width ?? 0) > 1 || (height ?? 0) > 1) return false;
  if (width !== undefined && height !== undefined) return true;
  if (width === 0 || height === 0) return true;
  return isHidden(attributes, style);
}

function isHidden(attributes: Map<string, string>, style: Map<string, string>) {
  if (attributes.has("hidden")) return true;
  const display = style.get("display");
  const visibility = style.get("visibility");
  const opacity = style.get("opacity");
  return (
    display?.startsWith("none") === true ||
    visibility?.startsWith("hidden") === true ||
    (opacity !== undefined && Number.parseFloat(opacity) === 0)
  );
}

function isKnownTrackerUrl(url: URL) {
  const host = url.hostname.toLowerCase();
  if (
    TRACKER_HOSTS.some(
      (tracker) => host === tracker || host.endsWith(`.${tracker}`),
    )
  ) {
    return true;
  }
  return TRACKER_PATHS.some((pattern) => pattern.test(url.pathname));
}

function parseRemoteUrl(src: string) {
  const absolute = src.startsWith("//") ? `https:${src}` : src;
  if (!/^https?:\/\//i.test(absolute)) return null;
  try {
    return new URL(absolute);
  } catch {
    return null;
  }
}

/** Returns a length in pixels, 0 for any zero length, or undefined. */
function readLength(value: string | undefined) {
  if (value === undefined) return;
  const cleaned = value.replace(/!important/i, "");
  if (ZERO_LENGTH.test(cleaned)) return 0;
  const match = cleaned.match(PIXEL_LENGTH);
  return match ? Number.parseFloat(match[1]) : undefined;
}

function parseAttributes(tag: string) {
  const attributes = new Map<string, string>();
  const body = tag.replace(/^<img\b/i, "").replace(/\/?>$/, "");
  for (const match of body.matchAll(ATTRIBUTE)) {
    const name = match[1].toLowerCase();
    if (attributes.has(name)) continue;
    attributes.set(name, match[2] ?? match[3] ?? match[4] ?? "");
  }
  return attributes;
}

function parseStyle(style: string) {
  const declarations = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const separator = declaration.indexOf(":");
    if (separator === -1) continue;
    const property = declaration.slice(0, separator).trim().toLowerCase();
    const value = declaration
      .slice(separator + 1)
      .trim()
      .toLowerCase();
    if (property && value) declarations.set(property, value);
  }
  return declarations;
}
