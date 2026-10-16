/** A sidebar row clicked for a route the server still has to answer. */
export type PendingNavigation = { href: string; from: string };

/**
 * Whether a sidebar row shows as current. While a navigation the click
 * started is under way, the row it heads to does, so the click answers at
 * once rather than when the server does. Once the address changes, or if the
 * navigation never leaves, the open view decides again.
 */
export function isSidebarRowActive({
  active,
  href,
  pending,
  pathname,
}: {
  active: boolean;
  href: string | undefined;
  pending: PendingNavigation | null;
  pathname: string;
}) {
  if (!pending || pending.from !== pathname) return active;
  return href === pending.href;
}
