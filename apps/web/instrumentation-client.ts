// This file configures the initialization of Sentry on the client.
// The config you add here will be used whenever a users loads a page in their browser.
// https://docs.sentry.io/platforms/javascript/guides/nextjs/

import * as Sentry from "@sentry/nextjs";
import { env } from "@/env";
import { beforeSend, beforeSendTransaction } from "@/utils/sentry-scrub";
import { installStaleDeploymentReload } from "@/utils/stale-deployment";
import {
  canUseTrackingCookies,
  subscribeToCookieConsent,
} from "@/utils/cookie-consent";

const REPLAY_SESSION_SAMPLE_RATE = 0.1;

type Replay = ReturnType<typeof Sentry.replayIntegration>;

Sentry.init({
  dsn: env.NEXT_PUBLIC_SENTRY_DSN,

  // Adjust this value in production, or use tracesSampler for greater control
  tracesSampleRate: 0.1,

  // Setting this option to true will print useful information to the console while you're setting up Sentry.
  debug: false,

  // Redact PII/secrets before sending to Sentry (third party).
  beforeSend,
  beforeSendTransaction,

  // Session replay stores data in the browser, so it waits for cookie consent
  // where that is required.
  replaysOnErrorSampleRate: canUseTrackingCookies() ? 1.0 : 0,
  replaysSessionSampleRate: canUseTrackingCookies()
    ? REPLAY_SESSION_SAMPLE_RATE
    : 0,
});

// Replay is a large part of Sentry's bundle, and recording snapshots the
// whole page, so it joins once the first screen has settled rather than
// competing with the mail engine and the inbox's first render.
const REPLAY_START_DELAY_MS = 10_000;
const replayReady = env.NEXT_PUBLIC_SENTRY_DSN
  ? loadReplayAfterPageSettles()
  : Promise.resolve(undefined);

if (!canUseTrackingCookies()) {
  const unsubscribe = subscribeToCookieConsent(() => {
    if (!canUseTrackingCookies()) return;

    unsubscribe();
    // Mirrors the sampling Sentry applies when consent exists at page load:
    // some sessions are recorded in full, the rest only around errors.
    replayReady.then((replay) => {
      if (Math.random() < REPLAY_SESSION_SAMPLE_RATE) replay?.start();
      else replay?.startBuffering();
    });
  });
}

installStaleDeploymentReload();

export const onRouterTransitionStart = Sentry.captureRouterTransitionStart;

function loadReplayAfterPageSettles() {
  return new Promise<Replay | undefined>((resolve) => {
    const load = () => {
      import("@sentry/nextjs")
        .then(({ replayIntegration }) => {
          const replay = replayIntegration({
            maskAllText: true,
            blockAllMedia: true,
          });
          Sentry.addIntegration(replay);
          resolve(replay);
        })
        .catch(() => resolve(undefined));
    };
    const whenIdle = () => {
      if (typeof window.requestIdleCallback === "function") {
        window.requestIdleCallback(load, { timeout: 5000 });
      } else {
        load();
      }
    };
    const schedule = () => setTimeout(whenIdle, REPLAY_START_DELAY_MS);
    if (document.readyState === "complete") schedule();
    else window.addEventListener("load", schedule, { once: true });
  });
}
