"use client";

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { Coverage, MailboxView } from "@inboxzero/mail-core/queries";
import { useAccounts } from "@/hooks/useAccounts";
import { supportsImportantPeople } from "@/hooks/useImportantPeople";
import { useAccount } from "@/providers/EmailAccountProvider";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { BRAND_ICON_URL } from "@/utils/branding";
import { buildMailPath } from "@/utils/mail-url";
import type { CueMembershipResponse } from "@/app/api/user/mail-splits/cue-membership/route";
import {
  claimNotifierLeadership,
  createNewMailNotifier,
  showNewMailNotifications,
} from "@/utils/web-notifications/notifier";
import {
  chooseWebNotificationMode,
  getWebNotificationPermission,
  isDesktopShell,
  recordWebNotificationOffer,
  shouldOfferWebNotifications,
} from "@/utils/web-notifications/permission";
import {
  hasBeenAskedToEnable,
  readEffectiveMode,
  readQuietUntilMs,
  readStoredMode,
  subscribeToPreference,
} from "@/utils/web-notifications/preference";
import {
  openFocusChannel,
  trackCueTabFocus,
} from "@/utils/web-notifications/tab-focus";
import type { TrackedConversation } from "@/utils/web-notifications/new-mail";
import {
  isWebPushAvailable,
  isWebPushResyncDue,
  syncWebPushSubscription,
} from "@/utils/web-push/subscription";
import { syncWithRetry } from "@/utils/web-push/sync-with-retry";

const MAX_WATCHED_ACCOUNTS = 50;
const WATCHED_UNREAD_PAGE_SIZE = 25;
const TRIAGE_SETTLE_MS = 15_000;
const OFFER_DELAY_MS = 4000;
const OFFER_TOAST_DURATION_MS = 15_000;

/**
 * Browser notifications for new inbox mail while a Cue tab is open. The desktop
 * app notifies on its own; with several tabs open one of them notifies. Nothing
 * is watched unless the reader has turned notifications on and the browser
 * allows them.
 */
export function WebNewMailNotifications() {
  const client = useOptionalMailClient();
  const router = useRouter();
  const { accountIds: orderedAccountIds } = useAccount();
  const { data } = useAccounts();
  const permission = useSyncExternalStore(
    subscribeToPreference,
    getWebNotificationPermission,
    () => "unsupported" as const,
  );
  const mode = useSyncExternalStore(
    subscribeToPreference,
    readEffectiveMode,
    () => "off" as const,
  );
  const storedMode = useSyncExternalStore(
    subscribeToPreference,
    readStoredMode,
    () => null,
  );
  // The desktop app shows its own notifications.
  const isDesktopApp = useSyncExternalStore(
    subscribeToPreference,
    isDesktopShell,
    () => true,
  );

  const connectedKey = (data?.emailAccounts ?? [])
    .filter((account) => !account.account.disconnectedAt)
    .map((account) => account.id)
    .sort()
    .slice(0, MAX_WATCHED_ACCOUNTS)
    .join("\0");
  const connectedAccountIds = useMemo(
    () => (connectedKey ? connectedKey.split("\0") : []),
    [connectedKey],
  );

  // Read when a notification is clicked, not when the watcher is set up.
  const openThreadRef = useRef<(accountId: string, threadId: string) => void>(
    () => undefined,
  );
  openThreadRef.current = (accountId, threadId) => {
    const accountIndex = orderedAccountIds.indexOf(accountId);
    if (accountIndex < 0) return;
    router.push(
      buildMailPath({ accountIndex, view: { kind: "inbox" }, threadId }),
    );
  };

  // Read for each batch of new mail, so a star set a moment ago counts.
  const clientRef = useRef(client);
  clientRef.current = client;

  const active = !isDesktopApp && permission === "granted" && mode !== "off";
  const notifierRef =
    useRef<ReturnType<typeof createNewMailNotifier>>(undefined);

  // The notifier outlives account changes, so mail that arrives while the
  // watched accounts change is still recognised as new.
  useEffect(() => {
    if (!active) return;
    let leader = false;
    const releaseLeadership = claimNotifierLeadership({
      locks: navigator.locks,
      onChange: (next) => {
        leader = next;
      },
    });
    const focus = trackCueTabFocus({
      channel: openFocusChannel(),
      isThisTabFocused: () =>
        document.visibilityState === "visible" && document.hasFocus(),
    });
    const notifier = createNewMailNotifier({
      startedAtMs: Date.now(),
      getMode: () =>
        getWebNotificationPermission() === "granted"
          ? readEffectiveMode()
          : "off",
      // Read from storage each time: the pause may be set in another tab.
      isQuiet: () => readQuietUntilMs() !== null,
      isLeader: () => leader,
      isForeground: focus.isAnyTabFocused,
      notify: (conversations) =>
        showNewMailNotifications({
          conversations,
          Notification,
          icon: BRAND_ICON_URL,
          summaryTitle: (count) => `${count} more new messages`,
          focusWindow: () => window.focus(),
          openThread: (conversation) =>
            openThreadRef.current(
              conversation.accountId,
              conversation.threadId,
            ),
        }),
      loadBulkMessageIds,
      loadImportantPeople: async (accountIds) => {
        const current = clientRef.current;
        if (!supportsImportantPeople(current)) return null;
        return current.queryImportantPeople(accountIds);
      },
      triageSettleMs: TRIAGE_SETTLE_MS,
    });
    notifierRef.current = notifier;
    return () => {
      notifierRef.current = undefined;
      notifier.dispose();
      focus.dispose();
      releaseLeadership();
    };
  }, [active]);

  useEffect(() => {
    if (!active || !client || connectedAccountIds.length === 0) return;
    const handle = client.observeMailbox({
      accountIds: connectedAccountIds,
      predicate: {
        kind: "all",
        predicates: [
          { kind: "role", role: "inbox" },
          { kind: "read", value: false },
        ],
      },
      order: "newest_first",
      pageSize: WATCHED_UNREAD_PAGE_SIZE,
      after: null,
    });
    const apply = () => {
      const snapshot = handle.getSnapshot();
      if (snapshot.status !== "ready" || !snapshot.data) return;
      notifierRef.current?.handle(
        toTracked(snapshot.data),
        unsyncedAccounts(snapshot.data.coverage, connectedAccountIds),
      );
    };
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
    };
  }, [active, client, connectedAccountIds]);

  // Keeps the server's copy of this browser's push subscription fresh, so mail
  // still notifies after the browser rotates it or the server dropped it. A
  // pause leaves it alone: the server holds pushes back until the pause ends.
  useEffect(() => {
    if (!active || !isWebPushAvailable() || !isWebPushResyncDue()) return;
    return syncWithRetry({
      sync: () => syncWebPushSubscription(mode),
      // The scoped logger reads server-only env, so the browser warns directly.
      onFailure: (attempt) =>
        console.warn(
          `[web-push] Subscription sync failed (attempt ${attempt + 1})`,
        ),
    });
  }, [active, mode]);

  // The one-time offer needs to know a first sync finished, and nothing else.
  const mightOffer =
    !isDesktopApp &&
    permission === "default" &&
    storedMode === null &&
    !hasBeenAskedToEnable();
  useEffect(() => {
    if (!mightOffer || !client || connectedAccountIds.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const handle = client.observeMailbox({
      accountIds: connectedAccountIds.slice(0, 1),
      predicate: { kind: "role", role: "inbox" },
      order: "newest_first",
      pageSize: 1,
      after: null,
    });
    const apply = () => {
      const view = handle.getSnapshot().data;
      if (timer || !view) return;
      if (!view.coverage.some((c) => c.lastCompletedSyncAtMs !== null)) return;
      timer = setTimeout(offerNotifications, OFFER_DELAY_MS);
    };
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
      if (timer) clearTimeout(timer);
    };
  }, [mightOffer, client, connectedAccountIds]);

  return null;
}

function offerNotifications() {
  if (
    !shouldOfferWebNotifications({
      permission: getWebNotificationPermission(),
      isDesktopApp: isDesktopShell(),
      firstSyncCompleted: true,
      storedMode: readStoredMode(),
    })
  )
    return;
  recordWebNotificationOffer();
  toast("Get notified about new mail?", {
    description: "Cue can alert you when important mail arrives.",
    duration: OFFER_TOAST_DURATION_MS,
    action: {
      label: "Turn on",
      onClick: () => {
        chooseWebNotificationMode("important").catch(() => undefined);
      },
    },
    cancel: { label: "Not now", onClick: () => undefined },
  });
}

function toTracked(view: MailboxView): TrackedConversation[] {
  return view.conversations.flatMap((conversation) =>
    conversation.latestMessageId
      ? [
          {
            id: conversation.latestMessageId,
            accountId: conversation.key.accountId,
            threadId: conversation.key.conversationId,
            from: conversation.from,
            subject: conversation.subject,
            latestMessageAtMs: conversation.latestMessageAtMs,
          },
        ]
      : [],
  );
}

// An account this browser has never finished syncing (one that is excluded
// from All inboxes may never be) holds back only its own mail.
function unsyncedAccounts(coverage: Coverage[], accountIds: string[]) {
  return new Set(
    accountIds.filter(
      (accountId) =>
        !coverage.some(
          (entry) =>
            entry.accountId === accountId &&
            entry.lastCompletedSyncAtMs !== null,
        ),
    ),
  );
}

async function loadBulkMessageIds(accountId: string) {
  try {
    const response = await fetch("/api/user/mail-splits/cue-membership", {
      headers: { [EMAIL_ACCOUNT_HEADER]: accountId },
    });
    if (!response.ok) return null;
    const membership: CueMembershipResponse = await response.json();
    return new Set([...membership.NEWSLETTER, ...membership.MARKETING]);
  } catch {
    return null;
  }
}
