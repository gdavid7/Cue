"use client";

import { useEffect } from "react";
import type { PostHog } from "posthog-js";
import { useSession } from "@/utils/auth-client";
import { usePathname, useSearchParams } from "next/navigation";
import { env } from "@/env";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  getAppPageViewProperties,
  getPageViewPathname,
  getPageViewSearch,
  stripUntrackedUrlParams,
  PRODUCT_ANALYTICS_EVENTS,
} from "@/utils/analytics/product";
import { getClientAnalyticsProperties } from "@/utils/analytics/client";
import { loadPostHog, posthog } from "@/utils/analytics/posthog-client";
import { clearPendingAuthProvider } from "@/utils/analytics/auth-funnel";
import { startDesktopHealthReporting } from "@/utils/analytics/desktop-health";
import { ONE_DAY_MS } from "@/utils/date";
import { scheduleAfterPageLoad } from "@/utils/schedule-after-page-load";
import {
  canUseTrackingCookies,
  subscribeToCookieConsent,
} from "@/utils/cookie-consent";

// based on: https://posthog.com/docs/libraries/next-js

export function PostHogPageview() {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const pageViewSearch = getPageViewSearch(searchParams);
  const pageViewPathname = pathname ? getPageViewPathname(pathname) : null;

  useEffect(() => {
    if (!pageViewPathname) return;

    const query = pageViewSearch ? `?${pageViewSearch}` : "";
    posthog.capture("$pageview", {
      $current_url: `${window.origin}${pageViewPathname}${query}`,
    });

    const appPageProperties = getAppPageViewProperties({
      pathname: pageViewPathname,
      searchParams: new URLSearchParams(pageViewSearch),
    });
    if (appPageProperties) {
      posthog.capture(PRODUCT_ANALYTICS_EVENTS.pageViewed, appPageProperties);
    }
  }, [pageViewPathname, pageViewSearch]);

  return null;
}

export function PostHogIdentify() {
  const { data: session } = useSession();
  const { emailAccount } = useAccount();
  const userEmail = session?.user.email;
  const userCreatedAt = session?.user.createdAt;

  useEffect(() => {
    if (!userEmail) return;

    clearPendingAuthProvider();

    const signedUpOverOneDayAgo =
      !!userCreatedAt &&
      Date.now() - new Date(userCreatedAt).getTime() > ONE_DAY_MS;

    posthog.identify(userEmail, {
      email: userEmail,
      ...(signedUpOverOneDayAgo && { signed_up_over_1_day: true }),
    });
  }, [userCreatedAt, userEmail]);

  useEffect(() => {
    // Set super properties that will be included with all events
    posthog.register({
      email_account_id: emailAccount?.id,
      email_account_email: emailAccount?.email,
      email_account_provider: emailAccount?.account?.provider,
    });

    // Most users only use one email account, and it's helpful to have the provider on the person property
    if (emailAccount) {
      posthog.setPersonProperties(
        {},
        {
          default_email_account_provider: emailAccount?.account?.provider,
        },
      );
    }
  }, [emailAccount]);

  return null;
}

export function PostHogProvider({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <DeferredPostHog />
    </>
  );
}

// PostHog is a large library and nothing on screen needs it, so it downloads
// once the page has loaded. Calls made before then are queued and replayed.
// A first click or key press may lead straight to a navigation away (sign-in
// redirects in particular), so it starts the download early, as does the
// login page itself.
function DeferredPostHog() {
  const pathname = usePathname();
  const onLoginPage = isLoginPath(pathname);

  useEffect(() => {
    if (!env.NEXT_PUBLIC_POSTHOG_KEY) return;

    const load = () => loadPostHog(initPostHog);
    if (onLoginPage) {
      load();
      return;
    }
    const options = { capture: true, once: true, passive: true };
    window.addEventListener("pointerdown", load, options);
    window.addEventListener("keydown", load, options);
    const cancelScheduledLoad = scheduleAfterPageLoad(load, {
      fallbackDelay: 2000,
      idleTimeout: 5000,
    });
    return () => {
      window.removeEventListener("pointerdown", load, options);
      window.removeEventListener("keydown", load, options);
      cancelScheduledLoad();
    };
  }, [onLoginPage]);

  return null;
}

function initPostHog(instance: PostHog, key: string) {
  instance.init(key, {
    api_host: env.NEXT_PUBLIC_POSTHOG_API_HOST, // https://posthog.com/docs/advanced/proxy/nextjs
    capture_pageview: false, // Disable automatic pageview capture, as we capture manually
    disable_session_recording: !canUseTrackingCookies(),
    // Without consent, nothing is written to cookies or storage, so an
    // anonymous visitor is only recognized within the current page session.
    persistence: canUseTrackingCookies() ? "localStorage+cookie" : "memory",
    before_send: stripUntrackedUrlParams,
  });
  instance.register(getClientAnalyticsProperties());
  startDesktopHealthReporting();
  subscribeToCookieConsent(() => {
    if (!canUseTrackingCookies()) {
      instance.set_config({
        persistence: "memory",
        disable_session_recording: true,
      });
      return;
    }

    instance.set_config({
      persistence: "localStorage+cookie",
      disable_session_recording: false,
    });
  });
}

function isLoginPath(pathname: string | null) {
  return pathname === "/login" || Boolean(pathname?.startsWith("/login/"));
}
