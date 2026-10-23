"use client";

import type React from "react";
import { useEffect, useRef } from "react";
import { usePathname } from "next/navigation";
import {
  SAVE_OFFLINE_MAIL,
  SKIP_WAITING,
  isOfflineMailPath,
} from "@/utils/offline/mail-cache";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { SerwistProvider, useSerwist } from "@serwist/next/react";
import { guardRestoredPage } from "@/utils/restored-page";
import { isSigningOut } from "@/utils/signing-out";
import { SWRConfig } from "swr";
import { swrFetcher } from "./swr-fetcher";
import {
  DESKTOP_WEB_UPDATE_LAST_PROMPTED_KEY,
  getInboxZeroDesktopApp,
  shouldCheckForDesktopWebUpdate,
  shouldPromptDesktopWebUpdate,
} from "@/utils/desktop-app";
import { showUpdateAvailableToast } from "@/utils/update-available-toast";
import { noteBuildReloadNavigation } from "@/utils/build-reload";
import { ThemeProvider } from "@/components/theme-provider";

const DESKTOP_WEB_UPDATE_PROMPT_GRACE_MS = 3000;

export function GlobalProviders(props: { children: React.ReactNode }) {
  return (
    // Registers the service worker built by `serwist build`; the @serwist/next
    // webpack plugin used to inject this registration, but it doesn't support
    // Turbopack. cacheOnNavigation={false} matches the old plugin default.
    // Its reload on reconnect would drop whatever is on screen; the mail
    // engine and draft saves resume by themselves when the network returns.
    <SerwistProvider
      swUrl="/sw.js"
      register={false}
      cacheOnNavigation={false}
      reloadOnOnline={false}
      disable={process.env.NODE_ENV !== "production"}
    >
      <ManageServiceWorker />
      <RestoredPageGuard />
      <LoadNewBuildOnNavigation />
      <SignalDesktopReady />
      <ThemeProvider>
        <SWRConfig value={{ fetcher: swrFetcher, isPaused: isSigningOut }}>
          <NuqsAdapter>{props.children}</NuqsAdapter>
        </SWRConfig>
      </ThemeProvider>
    </SerwistProvider>
  );
}

// A tab running an older build than the server's loads its next route in
// full, as Next.js does when its own navigations find the build changed.
function LoadNewBuildOnNavigation() {
  const pathname = usePathname();
  const previous = useRef(pathname);
  useEffect(() => {
    if (previous.current === pathname) return;
    previous.current = pathname;
    noteBuildReloadNavigation();
  }, [pathname]);
  return null;
}

function RestoredPageGuard() {
  useEffect(() => guardRestoredPage(), []);
  return null;
}

// SerwistProvider's own register drops the promise, so the failures that come
// with crawlers, webviews and private browsing surface as unhandled rejections.
// Registration failures must not interrupt the online app.
function ManageServiceWorker() {
  const { serwist } = useSerwist();
  const pathname = usePathname();

  useEffect(() => {
    if (!serwist) return;

    const isDesktopApp = Boolean(getInboxZeroDesktopApp());
    const pageLoadedAt = Date.now();
    let hadController = Boolean(navigator.serviceWorker.controller);
    let lastCheckedAt: number | null = null;
    let lastPromptedAt = readDesktopWebUpdateLastPromptedAt();
    let registration: ServiceWorkerRegistration | undefined;
    let stopWatchingForWaiting: (() => void) | undefined;
    let refreshing = false;

    const saveOfflineMail = () => {
      saveOfflineMailPage(
        navigator.serviceWorker.controller ?? registration?.active,
      );
    };

    const reloadForUpdate = () => {
      if (refreshing) return;
      refreshing = true;
      window.location.reload();
    };

    const activateWaitingWorker = () => {
      registration?.waiting?.postMessage({ type: SKIP_WAITING });
      reloadForUpdate();
    };

    const notifyAboutWaitingUpdate = () => {
      const now = Date.now();
      if (
        !shouldPromptDesktopWebUpdate({
          isDesktopApp,
          hasController: Boolean(navigator.serviceWorker.controller),
          hasWaitingWorker: Boolean(registration?.waiting),
          lastPromptedAt,
          now,
        })
      ) {
        return;
      }

      lastPromptedAt = now;
      writeDesktopWebUpdateLastPromptedAt(now);
      showUpdateAvailableToast(activateWaitingWorker);
    };

    const handleWaitingWorker = () => {
      if (!registration?.waiting) return;
      if (!navigator.serviceWorker.controller) {
        registration.waiting.postMessage({ type: SKIP_WAITING });
        return;
      }
      notifyAboutWaitingUpdate();
    };

    const watchForWaitingWorker = (
      serviceWorkerRegistration: ServiceWorkerRegistration,
    ) => {
      stopWatchingForWaiting?.();
      registration = serviceWorkerRegistration;
      const onUpdateFound = () => {
        const installing = serviceWorkerRegistration.installing;
        if (!installing) return;
        installing.addEventListener("statechange", () => {
          if (installing.state === "installed") handleWaitingWorker();
        });
      };
      serviceWorkerRegistration.addEventListener("updatefound", onUpdateFound);
      stopWatchingForWaiting = () => {
        serviceWorkerRegistration.removeEventListener(
          "updatefound",
          onUpdateFound,
        );
      };
      handleWaitingWorker();
    };

    const onControllerChange = () => {
      saveOfflineMail();
      if (
        !refreshing &&
        hadController &&
        isDesktopApp &&
        Date.now() - pageLoadedAt >= DESKTOP_WEB_UPDATE_PROMPT_GRACE_MS
      ) {
        showUpdateAvailableToast(reloadForUpdate);
      }
      hadController = true;
    };

    const checkForUpdate = async () => {
      const now = Date.now();
      if (
        !shouldCheckForDesktopWebUpdate({
          isDesktopApp,
          isOnline: navigator.onLine,
          isVisible: document.visibilityState === "visible",
          lastCheckedAt,
          now,
        })
      ) {
        return;
      }

      lastCheckedAt = now;
      saveOfflineMail();
      try {
        registration ??= await navigator.serviceWorker.getRegistration();
        if (registration) watchForWaitingWorker(registration);
        await registration?.update();
        handleWaitingWorker();
      } catch {
        // Update checks are best-effort and should never interrupt the app.
      }
    };

    navigator.serviceWorker.addEventListener(
      "controllerchange",
      onControllerChange,
    );
    document.addEventListener("visibilitychange", checkForUpdate);
    window.addEventListener("online", checkForUpdate);

    const cancelRegistration = runWhenPageSettles(() => {
      serwist
        .register()
        .then((serviceWorkerRegistration) => {
          if (serviceWorkerRegistration) {
            watchForWaitingWorker(serviceWorkerRegistration);
          }
          saveOfflineMail();
          return checkForUpdate();
        })
        .catch(() => {});
    });

    return () => {
      cancelRegistration();
      stopWatchingForWaiting?.();
      navigator.serviceWorker.removeEventListener(
        "controllerchange",
        onControllerChange,
      );
      document.removeEventListener("visibilitychange", checkForUpdate);
      window.removeEventListener("online", checkForUpdate);
    };
  }, [serwist]);

  useEffect(() => {
    if (!serwist || !pathname || !isOfflineMailPath(pathname)) return;
    saveOfflineMailPage(navigator.serviceWorker.controller);
  }, [serwist, pathname]);

  return null;
}

function SignalDesktopReady() {
  useEffect(() => {
    getInboxZeroDesktopApp()?.signalReady?.();
  }, []);
  return null;
}

function saveOfflineMailPage(worker: ServiceWorker | null | undefined) {
  if (
    !isOfflineMailPath(window.location.pathname) ||
    !navigator.onLine ||
    document.visibilityState !== "visible"
  )
    return;
  worker?.postMessage({ type: SAVE_OFFLINE_MAIL });
}

// Installing the worker downloads its precache, which would otherwise compete
// with the first visit's own requests for bandwidth and main-thread time.
function runWhenPageSettles(callback: () => void) {
  let idleHandle: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    if (typeof window.requestIdleCallback === "function") {
      idleHandle = window.requestIdleCallback(callback, { timeout: 5000 });
    } else {
      timer = setTimeout(callback, 1000);
    }
  };
  if (document.readyState === "complete") schedule();
  else window.addEventListener("load", schedule, { once: true });
  return () => {
    window.removeEventListener("load", schedule);
    if (idleHandle !== undefined) window.cancelIdleCallback(idleHandle);
    if (timer !== undefined) clearTimeout(timer);
  };
}

function readDesktopWebUpdateLastPromptedAt(): number | null {
  try {
    const raw = sessionStorage.getItem(DESKTOP_WEB_UPDATE_LAST_PROMPTED_KEY);
    if (!raw) return null;
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function writeDesktopWebUpdateLastPromptedAt(now: number) {
  try {
    sessionStorage.setItem(DESKTOP_WEB_UPDATE_LAST_PROMPTED_KEY, String(now));
  } catch {
    // Private browsing can block storage; the in-memory timestamp still
    // coalesces prompts until the page reloads.
  }
}
