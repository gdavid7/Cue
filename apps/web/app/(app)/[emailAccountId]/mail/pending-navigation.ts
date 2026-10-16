import { useCallback, useEffect, useRef, useState } from "react";

/** A sidebar row clicked for a route the server still has to answer. */
export type PendingNavigation = { href: string; from: string };

// Long enough for a slow server. A navigation sent back to where it started
// never changes the address, so without this the highlight would stay.
const PENDING_NAVIGATION_TIMEOUT_MS = 10_000;

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

/**
 * The navigation a sidebar click started, until the address changes or it
 * has had long enough to.
 */
export function usePendingNavigation(pathname: string) {
  const [pending, setPending] = useState<PendingNavigation | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  const start = useCallback(
    (href: string) => {
      clearTimeout(timer.current);
      setPending({ href, from: pathname });
      timer.current = setTimeout(
        () => setPending(null),
        PENDING_NAVIGATION_TIMEOUT_MS,
      );
    },
    [pathname],
  );
  return { pending: pending?.from === pathname ? pending : null, start };
}
