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

// Open-tracking paths of common sending platforms, each only on that
// platform's own hosts so a sender's similarly named page is left alone.
const TRACKER_PATHS = [
  { hosts: ["list-manage.com"], path: /^\/track\/open\.php$/i }, // Mailchimp
  { hosts: ["mandrillapp.com"], path: /^\/track\/open\.php$/i }, // Mandrill
  { hosts: ["sendgrid.net"], path: /^\/wf\/open$/i }, // SendGrid
  // Salesforce Marketing Cloud
  { hosts: ["exacttarget.com", "exct.net"], path: /^\/open\.aspx$/i },
];

/**
 * Whether an <img> exists only to tell the sender the email was opened: a
 * remote image declared 0 or 1px in size, or one from a known open-tracking
 * host or platform path. An image declared larger than a pixel is kept even
 * when it starts hidden, since responsive emails reveal those with media
 * queries. CSS and `background` attribute images are out of scope.
 */
export function isTrackingImage(
  getAttribute: (name: string) => string | null | undefined,
) {
  const url = parseRemoteUrl(getImageSource(getAttribute));
  if (!url) return false;
  const host = url.hostname.toLowerCase();
  if (TRACKER_HOSTS.some((tracker) => isHostOrSubdomain(host, tracker))) {
    return true;
  }

  const style = parseStyle(getAttribute("style") ?? "");
  const width = readLength(style.get("width") ?? getAttribute("width"));
  const height = readLength(style.get("height") ?? getAttribute("height"));
  if (isVisibleSize(width) || isVisibleSize(height)) return false;

  if (
    TRACKER_PATHS.some(
      ({ hosts, path }) =>
        hosts.some((platform) => isHostOrSubdomain(host, platform)) &&
        path.test(url.pathname),
    )
  ) {
    return true;
  }

  return width !== undefined || height !== undefined;
}

function getImageSource(
  getAttribute: (name: string) => string | null | undefined,
) {
  const src = getAttribute("src")?.trim();
  if (src) return src;
  return getAttribute("srcset")?.trim().split(/\s+/, 1)[0]?.replace(/,$/, "");
}

function isHostOrSubdomain(host: string, domain: string) {
  return host === domain || host.endsWith(`.${domain}`);
}

/** A length that renders more than a pixel, or one in units we can't size. */
function isVisibleSize(length: number | null | undefined) {
  return length === null || (length !== undefined && length > 1);
}

function parseRemoteUrl(src: string | undefined) {
  if (!src) return null;
  const absolute = src.startsWith("//") ? `https:${src}` : src;
  if (!/^https?:\/\//i.test(absolute)) return null;
  try {
    return new URL(absolute);
  } catch {
    return null;
  }
}

/**
 * Pixels for a pixel or zero length, null for any other declared length
 * (such as 100% or auto), undefined when none is declared.
 */
function readLength(value: string | null | undefined) {
  if (value === null || value === undefined) return;
  const cleaned = value.replace(/!important/i, "");
  if (!cleaned.trim()) return;
  if (ZERO_LENGTH.test(cleaned)) return 0;
  const match = cleaned.match(PIXEL_LENGTH);
  return match ? Number.parseFloat(match[1]) : null;
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
