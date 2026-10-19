"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect } from "react";
import { useTodayHref } from "@/hooks/useTodayHref";
import { useAccount } from "@/providers/EmailAccountProvider";

// How often activity may ask. Next answers from its own copy while that is
// fresh, so only an ask after its five minutes reaches the server.
const ASK_EVERY_MS = 30_000;
const ACTIVITY_EVENTS = ["pointerdown", "pointermove", "keydown", "wheel"];

type PrefetchOptions = NonNullable<
  Parameters<ReturnType<typeof useRouter>["prefetch"]>[1]
>;
// The whole route, as `<Link prefetch>` fetches it: Next's default for a
// dynamic route stops at its loading boundary, and Today has none.
const FULL_ROUTE = { kind: "full" } as unknown as PrefetchOptions;

/**
 * Keeps Today's route fetched ahead, so opening it never waits on the
 * server. `<Link prefetch>` fetches it once; Next's copy goes stale after
 * five minutes and is fetched again only on hover, which a tap, a shortcut
 * or a quick click outruns, and never for a tab left open. This asks again
 * when the user comes back to the tab and, while they are active in it, at
 * most every half minute. An idle or hidden tab asks nothing.
 */
export function KeepTodayPrefetched() {
  const router = useRouter();
  const { emailAccountId } = useAccount();
  const todayHref = useTodayHref();
  const onToday = usePathname()?.endsWith("/home") ?? false;
  const href = emailAccountId && !onToday ? todayHref : null;

  useEffect(() => {
    // As with <Link>, dev servers would compile the route on every ask.
    if (!href || process.env.NODE_ENV !== "production") return;
    let askedAt = Date.now();
    const ask = () => {
      askedAt = Date.now();
      router.prefetch(href, FULL_ROUTE);
    };
    const onActivity = () => {
      if (Date.now() - askedAt >= ASK_EVERY_MS) ask();
    };
    const onReturn = () => {
      if (document.visibilityState === "visible") ask();
    };
    for (const type of ACTIVITY_EVENTS)
      window.addEventListener(type, onActivity, { passive: true });
    document.addEventListener("visibilitychange", onReturn);
    window.addEventListener("focus", onReturn);
    return () => {
      for (const type of ACTIVITY_EVENTS)
        window.removeEventListener(type, onActivity);
      document.removeEventListener("visibilitychange", onReturn);
      window.removeEventListener("focus", onReturn);
    };
  }, [href, router]);

  return null;
}
