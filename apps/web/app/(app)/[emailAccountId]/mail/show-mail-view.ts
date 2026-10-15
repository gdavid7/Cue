import { parseMailPath } from "@/utils/mail-url";

/**
 * Shows another view of the mail screen that is already open, as a new
 * history entry. The screen renders from its layout and reads the view from
 * the address, so a router navigation would only wait on the server for an
 * empty page. Returns false when `href` leaves this account's mail screen,
 * which needs a real navigation.
 */
export function showMailView(href: string): boolean {
  const current = parseMailPath(
    window.location.pathname,
    window.location.search,
  );
  const url = new URL(href, window.location.href);
  const target =
    url.origin === window.location.origin
      ? parseMailPath(url.pathname, url.search)
      : null;
  if (!current || !target || target.accountIndex !== current.accountIndex)
    return false;
  const next = `${url.pathname}${url.search}`;
  if (next !== `${window.location.pathname}${window.location.search}`)
    window.history.pushState(null, "", next);
  return true;
}
