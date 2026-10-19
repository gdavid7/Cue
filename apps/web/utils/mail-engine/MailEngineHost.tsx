"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { usePathname } from "next/navigation";
import { Loader2Icon } from "lucide-react";
import type { MailClient } from "@inboxzero/mail-core/engine";
import { MailEngineProvider } from "@inboxzero/mail-react/MailEngineProvider";
import { LoadingContent } from "@/components/LoadingContent";
import { useHydrated } from "@/hooks/useHydrated";
import { Button } from "@/components/ui/button";
import { env } from "@/env";
import { useAccount } from "@/providers/EmailAccountProvider";
import {
  createBrowserMailEngine,
  prewarmMailEngineWorker,
  type BrowserMailEngine,
} from "@/utils/mail-engine/create-browser-engine";
import {
  createDesktopIpcMailClient,
  hasDesktopMailEngineIpc,
} from "@/utils/mail-engine/desktop-ipc";
import {
  selectMailEngineRuntimeMode,
  resolveMailEngineProvider,
  shouldStartMailEngine,
} from "@/utils/mail-engine/runtime-mode";
import { fetchEmailAccounts } from "@/utils/fetch-email-accounts";
import {
  followMailboxChanges,
  getFollowedAccountIds,
} from "@/utils/mail-engine/follow-mailbox-changes";
import { pollMailVersions } from "@/utils/mail-engine/poll-mail-versions";
import { getAllInboxesAccounts } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useAccounts } from "@/hooks/useAccounts";
import { useAllAccountsScope } from "@/hooks/useTodayHref";
import { announceTodayChanged } from "@/utils/home/today-changes";
import { browserMailEngineCapabilities } from "@/utils/mail-engine/worker-protocol";
import {
  MAIL_ENGINE_OWNER_LOCK,
  MAIL_ENGINE_TAB_CHANNEL,
  bindTabMailOwner,
  createBroadcastTabBus,
  createTabFollowerClient,
  disposeTabFollowerClient,
} from "@/utils/mail-engine/tab-channel";
import {
  setActiveMailClient,
  subscribeMailEngineLogout,
} from "@/utils/mail-engine/active-client";

type MailEngineRuntimeStatus = {
  client: MailClient | null;
  mounted: boolean;
  unavailable: boolean;
  /** A corrupt local mailbox is being rebuilt before the engine can start. */
  rebuilding: boolean;
  requestBrowserEngine: () => void;
  retryStart: () => void;
};

type MailEngineInspectTransport = "browser" | "desktop-ipc";

// On a page that starts the engine, its worker and SQLite load while the page
// hydrates instead of after; the worker opens nothing until the engine starts.
if (
  typeof window !== "undefined" &&
  !hasDesktopMailEngineIpc() &&
  browserMailEngineCapabilities().opfs &&
  shouldStartMailEngine({
    pathname: window.location.pathname,
    desktopIpc: false,
  })
) {
  prewarmMailEngineWorker();
}

const MailEngineRuntimeStatusContext = createContext<MailEngineRuntimeStatus>({
  client: null,
  mounted: false,
  unavailable: false,
  rebuilding: false,
  requestBrowserEngine: () => {},
  retryStart: () => {},
});

export function useMailEngineDemand() {
  const { requestBrowserEngine } = useContext(MailEngineRuntimeStatusContext);
  useEffect(requestBrowserEngine, [requestBrowserEngine]);
}

export function MailEngineRuntime({ children }: { children: ReactNode }) {
  const status = useContext(MailEngineRuntimeStatusContext);
  if (status.mounted) return children;
  return <MailEngineRuntimeInner>{children}</MailEngineRuntimeInner>;
}

export function MailEngineHost({
  children,
  fallback,
  showChildrenWhileStarting,
}: {
  children: ReactNode;
  fallback?: ReactNode;
  showChildrenWhileStarting?: boolean;
}) {
  return (
    <MailEngineRuntime>
      <MailCoverageGate
        fallback={fallback}
        showChildrenWhileStarting={showChildrenWhileStarting}
      >
        {children}
      </MailCoverageGate>
    </MailEngineRuntime>
  );
}

export function MailCoverageGate({
  children,
  fallback = <LoadingContent loading>{null}</LoadingContent>,
  showChildrenWhileStarting = false,
}: {
  children: ReactNode;
  /** Shown until the engine is ready, so the screen's frame needn't wait. */
  fallback?: ReactNode;
  /**
   * Shows the children as soon as the page has hydrated, for a screen that
   * reads as loading without the engine. Swapping a stand-in for it once the
   * engine is ready would remount it, closing any menu or dialog opened
   * meanwhile. The fallback still covers the server render.
   */
  showChildrenWhileStarting?: boolean;
}) {
  const status = useContext(MailEngineRuntimeStatusContext);
  // SSR has no OPFS; checking capabilities before hydration paints the
  // storage-error shell instead of the shared loading state.
  const hydrated = useHydrated();

  if (!hydrated) return fallback;
  const mode = selectMailEngineRuntimeMode({
    desktopIpc: hasDesktopMailEngineIpc(),
    opfs: browserMailEngineCapabilities().opfs,
  });
  if (status.unavailable || mode === "unavailable") {
    return <MailStorageUnavailable onRetry={status.retryStart} />;
  }
  if (!status.client && status.rebuilding) return <MailboxRebuilding />;
  if (!status.client && !showChildrenWhileStarting) return fallback;
  return children;
}

function MailEngineRuntimeInner({ children }: { children: ReactNode }) {
  const { accountIds, emailAccountId, provider, isLoading } = useAccount();
  // Read at start, so connecting another account does not restart the engine.
  const ownedAccountIds = useRef(accountIds);
  useEffect(() => {
    ownedAccountIds.current = accountIds;
  }, [accountIds]);
  const pathname = usePathname();
  const desktopIpc = useSyncExternalStore(
    subscribeNever,
    hasDesktopMailEngineIpc,
    () => false,
  );
  const [browserRequested, setBrowserRequested] = useState(false);
  const requestBrowserEngine = useCallback(() => setBrowserRequested(true), []);
  const enabled = shouldStartMailEngine({
    pathname,
    desktopIpc,
    browserRequested,
  });
  const mailProvider = resolveMailEngineProvider({
    accountsLoading: isLoading,
    provider,
  });
  const [client, setClient] = useState<MailClient | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [rebuilding, setRebuilding] = useState(false);
  const [startAttempt, setStartAttempt] = useState(0);
  const retryStart = useCallback(
    () => setStartAttempt((attempt) => attempt + 1),
    [],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: startAttempt is how Retry starts the engine again
  useEffect(() => {
    if (!emailAccountId || !enabled || !mailProvider) {
      setUnavailable(false);
      return;
    }
    // Narrowed copy: TypeScript drops the null check inside the async callbacks below.
    const engineProvider = mailProvider;
    // Keep queued sends and undo working after the initiating page or composer closes.
    if (!desktopIpc) requestBrowserEngine();
    setUnavailable(false);
    const mode = selectMailEngineRuntimeMode({
      desktopIpc,
      opfs: browserMailEngineCapabilities().opfs,
    });
    if (mode === "unavailable") {
      setUnavailable(true);
      return;
    }
    const abort = new AbortController();
    let published: MailClient | undefined;

    async function publishClient(
      next: MailClient,
      role: "owner" | "follower",
      transport: MailEngineInspectTransport,
    ) {
      if (abort.signal.aborted) return;
      if (published && published !== next) disposeTabFollowerClient(published);
      published = next;
      publishMailEngineInspect(next, emailAccountId, role, transport);
      setActiveMailClient(next);
      setRebuilding(false);
      setClient(next);
    }

    if (mode === "desktop-ipc") {
      const client = createDesktopIpcMailClient({
        provider: engineProvider,
      });
      publishClient(client, "owner", "desktop-ipc").catch(() => {
        if (!abort.signal.aborted) setUnavailable(true);
      });
      client.requestSync([emailAccountId]).catch(() => undefined);
      const unsubscribeLogout = subscribeMailEngineLogout(() => abort.abort());
      return () => {
        unsubscribeLogout();
        abort.abort();
        if (published) disposeTabFollowerClient(published);
        clearMailEngineInspect();
        setActiveMailClient(null);
        setClient(null);
      };
    }

    let engine: BrowserMailEngine | undefined;
    let unbindOwner: (() => void) | undefined;
    let unbindHello: (() => void) | undefined;
    const channel =
      typeof BroadcastChannel !== "undefined"
        ? new BroadcastChannel(MAIL_ENGINE_TAB_CHANNEL)
        : null;
    const bus = channel ? createBroadcastTabBus(channel) : null;

    if (bus) {
      unbindHello = bus.subscribe((message) => {
        if (message.type === "ready" && !engine && !published) {
          bus.post({
            type: "hello",
            accountId: emailAccountId,
            provider: engineProvider,
          });
          return;
        }
        if (
          message.type !== "owner" ||
          message.accountId !== emailAccountId ||
          engine ||
          published
        ) {
          return;
        }
        publishClient(
          createTabFollowerClient({
            accountId: emailAccountId,
            provider: engineProvider,
            bus,
          }),
          "follower",
          "browser",
        ).catch(() => undefined);
      });
      bus.post({
        type: "hello",
        accountId: emailAccountId,
        provider: engineProvider,
      });
    }

    async function hold(create: () => Promise<void>) {
      await create();
      await new Promise<void>((resolve) => {
        if (abort.signal.aborted) {
          resolve();
          return;
        }
        abort.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }

    async function start() {
      const create = async () => {
        engine = await createBrowserMailEngine(
          {
            accountId: emailAccountId,
            provider: engineProvider,
            online: typeof navigator === "undefined" || navigator.onLine,
            ownedAccountIds: [emailAccountId, ...ownedAccountIds.current],
          },
          {
            onRebuild: () => {
              if (!abort.signal.aborted) setRebuilding(true);
            },
          },
        );
        if (abort.signal.aborted) {
          await engine.close();
          return;
        }
        if (bus) {
          unbindOwner = bindTabMailOwner({
            client: engine,
            bus,
            ensureAccount: engine.ensureAccount,
          });
          bus.post({ type: "ready" });
          bus.post({ type: "owner", accountId: emailAccountId });
        }
        await publishClient(engine, "owner", "browser");
      };
      if (typeof navigator !== "undefined" && navigator.locks?.request) {
        await navigator.locks.request(
          MAIL_ENGINE_OWNER_LOCK,
          { signal: abort.signal },
          () => hold(create),
        );
        return;
      }
      await hold(create);
    }

    start().catch(() => {
      if (abort.signal.aborted) return;
      setRebuilding(false);
      setUnavailable(true);
    });

    const unsubscribeLogout = subscribeMailEngineLogout(() => {
      abort.abort();
      engine?.close().catch(() => undefined);
    });

    return () => {
      unsubscribeLogout();
      abort.abort();
      unbindOwner?.();
      unbindHello?.();
      if (published) disposeTabFollowerClient(published);
      clearMailEngineInspect();
      setActiveMailClient(null);
      channel?.close();
      engine?.close().catch(() => undefined);
      setRebuilding(false);
      setClient(null);
    };
  }, [
    emailAccountId,
    mailProvider,
    enabled,
    desktopIpc,
    requestBrowserEngine,
    startAttempt,
  ]);

  useEffect(() => {
    if (!client || !emailAccountId) return;
    let cancelled = false;
    // Accounts deleted on another device stay in this device's local store
    // and keep syncing until the server's list says they are gone. The open
    // account stays too, since an org admin may be viewing a member's mail.
    fetchEmailAccounts()
      .then(({ emailAccounts }) => {
        if (cancelled || emailAccounts.length === 0) return;
        return client.retainAccounts([
          emailAccountId,
          ...emailAccounts.map((account) => account.id),
        ]);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [client, emailAccountId]);

  const { data: accountsData } = useAccounts();
  const allAccounts = useAllAccountsScope();
  // A string, so a refetched account list that changed nothing keeps the streams.
  const followedAccountIds = emailAccountId
    ? getFollowedAccountIds(
        emailAccountId,
        getAllInboxesAccounts(accountsData?.emailAccounts ?? []).map(
          (account) => account.id,
        ),
        allAccounts,
      ).join(",")
    : "";
  useEffect(() => {
    // The desktop engine follows mailbox changes itself.
    if (!client || !followedAccountIds || hasDesktopMailEngineIpc()) return;
    const stops = followedAccountIds.split(",").map((accountId) =>
      followMailboxChanges({
        accountId,
        onChange: () => {
          client.requestSync([accountId]).catch(() => undefined);
        },
        onTrackersChange: () => announceTodayChanged(accountId),
      }),
    );
    return () => {
      for (const stop of stops) stop();
    };
  }, [client, followedAccountIds]);

  // Every account the engine keeps, so new mail reaches it (and its
  // notifications) while no tab streams that account.
  const polledAccountIds = emailAccountId
    ? [
        ...new Set([
          emailAccountId,
          ...(accountsData?.emailAccounts ?? []).map((account) => account.id),
        ]),
      ].join(",")
    : "";
  useEffect(() => {
    if (!client || !polledAccountIds || hasDesktopMailEngineIpc()) return;
    return pollMailVersions({
      accountIds: polledAccountIds.split(","),
      onChanged: (accountIds) => {
        client.requestSync(accountIds).catch(() => undefined);
      },
    });
  }, [client, polledAccountIds]);

  useEffect(() => {
    if (!client || !emailAccountId) return;
    const resumeDeferred = () => {
      if (!navigator.onLine) return;
      client.requestSync([emailAccountId]).catch(() => undefined);
    };
    window.addEventListener("online", resumeDeferred);
    return () => window.removeEventListener("online", resumeDeferred);
  }, [client, emailAccountId]);

  return (
    <MailEngineRuntimeStatusContext.Provider
      value={{
        client,
        mounted: true,
        unavailable,
        rebuilding,
        requestBrowserEngine,
        retryStart,
      }}
    >
      <MailEngineProvider client={client}>{children}</MailEngineProvider>
    </MailEngineRuntimeStatusContext.Provider>
  );
}

function MailStorageUnavailable({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex flex-1 items-center justify-center p-6">
      <div className="flex max-w-sm flex-col items-center gap-3 text-center">
        <p className="font-medium text-sm">
          Mail needs persistent browser storage.
        </p>
        <p className="text-muted-foreground text-sm">
          Your mailbox is kept in this browser. Private browsing, a full disk,
          or blocked site data can stop it from opening.
        </p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Retry
        </Button>
      </div>
    </div>
  );
}

function MailboxRebuilding() {
  return (
    <div
      className="flex flex-1 items-center justify-center p-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex max-w-sm flex-col items-center gap-2 text-center">
        <Loader2Icon
          aria-hidden
          className="size-5 text-muted-foreground motion-safe:animate-spin"
        />
        <p className="font-medium text-sm">Rebuilding your mailbox…</p>
        <p className="text-muted-foreground text-sm">
          Your drafts and unsent changes are kept.
        </p>
      </div>
    </div>
  );
}

function publishMailEngineInspect(
  client: MailClient,
  accountId: string,
  role: "owner" | "follower",
  transport: MailEngineInspectTransport,
) {
  if (!canExposeMailEngineInspect()) return;
  window.__inboxZeroMailInspect = {
    accountId,
    role,
    transport,
    capabilities: browserMailEngineCapabilities(),
    read: () => client.getDiagnostics(accountId),
    requestSync: () => client.requestSync([accountId]),
    inspect: () =>
      "inspect" in client && typeof client.inspect === "function"
        ? (
            client as MailClient & {
              inspect: () => Promise<unknown>;
            }
          ).inspect()
        : Promise.resolve(null),
  };
}

function clearMailEngineInspect() {
  if (typeof window === "undefined") return;
  window.__inboxZeroMailInspect = undefined;
}

function canExposeMailEngineInspect() {
  return (
    typeof window !== "undefined" &&
    (process.env.NODE_ENV !== "production" ||
      env.NEXT_PUBLIC_MAIL_ENGINE_TEST_INSPECT)
  );
}

function subscribeNever() {
  return () => undefined;
}

declare global {
  interface Window {
    __inboxZeroMailInspect?: {
      accountId: string;
      role: "owner" | "follower";
      transport: MailEngineInspectTransport;
      capabilities: ReturnType<typeof browserMailEngineCapabilities>;
      read: () => Promise<unknown>;
      requestSync: () => Promise<unknown>;
      inspect: () => Promise<unknown>;
    };
  }
}
