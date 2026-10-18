"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { useAccounts } from "@/hooks/useAccounts";
import { useAccount } from "@/providers/EmailAccountProvider";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { BRAND_ICON_URL } from "@/utils/branding";
import { getInboxZeroDesktopApp } from "@/utils/desktop-app";
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
  recordWebNotificationOffer,
  shouldOfferWebNotifications,
} from "@/utils/web-notifications/permission";
import {
  readEffectiveMode,
  readStoredMode,
} from "@/utils/web-notifications/preference";

const WATCHED_UNREAD_PAGE_SIZE = 25;
const TRIAGE_SETTLE_MS = 15_000;
const OFFER_DELAY_MS = 4000;
const OFFER_TOAST_DURATION_MS = 15_000;

/**
 * Browser notifications for new inbox mail while a Cue tab is open. The desktop
 * app notifies on its own; with several tabs open one of them notifies.
 */
export function WebNewMailNotifications() {
  const client = useOptionalMailClient();
  const router = useRouter();
  const { accountIds: orderedAccountIds } = useAccount();
  const { data } = useAccounts();
  const [firstSyncCompleted, setFirstSyncCompleted] = useState(false);

  const connectedKey = (data?.emailAccounts ?? [])
    .filter((account) => !account.account.disconnectedAt)
    .map((account) => account.id)
    .sort()
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

  useEffect(() => {
    if (!client || connectedAccountIds.length === 0) return;
    if (getInboxZeroDesktopApp()) return;
    if (getWebNotificationPermission() === "unsupported") return;

    let leader = false;
    const releaseLeadership = claimNotifierLeadership({
      locks: navigator.locks,
      onChange: (next) => {
        leader = next;
      },
    });
    const notifier = createNewMailNotifier({
      startedAtMs: Date.now(),
      getMode: () =>
        getWebNotificationPermission() === "granted"
          ? readEffectiveMode()
          : "off",
      isLeader: () => leader,
      isForeground: () =>
        document.visibilityState === "visible" && document.hasFocus(),
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
      triageSettleMs: TRIAGE_SETTLE_MS,
    });

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
      if (
        snapshot.data.coverage.some(
          (coverage) => coverage.lastCompletedSyncAtMs !== null,
        )
      )
        setFirstSyncCompleted(true);
      notifier.handle(
        snapshot.data.conversations.flatMap((conversation) =>
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
        ),
      );
    };
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
      notifier.dispose();
      releaseLeadership();
    };
  }, [client, connectedAccountIds]);

  useEffect(() => {
    if (!firstSyncCompleted) return;
    const timer = setTimeout(() => {
      if (
        !shouldOfferWebNotifications({
          permission: getWebNotificationPermission(),
          isDesktopApp: Boolean(getInboxZeroDesktopApp()),
          firstSyncCompleted,
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
    }, OFFER_DELAY_MS);
    return () => clearTimeout(timer);
  }, [firstSyncCompleted]);

  return null;
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
