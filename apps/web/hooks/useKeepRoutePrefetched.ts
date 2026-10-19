"use client";

import { PrefetchKind } from "next/dist/client/components/router-reducer/router-reducer-types";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

// Next keeps a prefetched route for five minutes, then fetches it again only
// when the pointer reaches its link. Asking this often keeps the gap short;
// a route still fresh is a no-op.
const CHECK_EVERY_MS = 30_000;

/**
 * Keeps `href`'s route fetched ahead while this page is in view, so opening it
 * never waits on the server. A `<Link prefetch>` alone goes stale for a tab
 * left open, and a tap, a shortcut or a quick click outruns the refetch its
 * hover starts. Returning to the tab asks at once.
 */
export function useKeepRoutePrefetched(href: string | null) {
  const router = useRouter();
  useEffect(() => {
    // As with <Link>, dev servers would compile the route on every ask.
    if (!href || process.env.NODE_ENV !== "production") return;
    const prefetch = () => {
      if (document.visibilityState !== "visible") return;
      router.prefetch(href, { kind: PrefetchKind.FULL });
    };
    const timer = setInterval(prefetch, CHECK_EVERY_MS);
    document.addEventListener("visibilitychange", prefetch);
    window.addEventListener("focus", prefetch);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", prefetch);
      window.removeEventListener("focus", prefetch);
    };
  }, [href, router]);
}
