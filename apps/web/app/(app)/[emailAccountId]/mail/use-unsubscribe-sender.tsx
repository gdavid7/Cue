"use client";

import { useCallback, useRef, useState } from "react";
import useSWR, { useSWRConfig } from "swr";
import { toast } from "sonner";
import { toastUndo } from "@/components/Toast";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { usePremiumModal } from "@/app/(app)/premium/PremiumModal";
import type { NewsletterStatsResponse } from "@/app/api/user/stats/newsletters/route";
import { usePremium } from "@/hooks/usePremium";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useArchiveSenderQueueActions } from "@/store/archive-sender-queue";
import { decrementUnsubscribeCreditAction } from "@/utils/actions/premium";
import {
  setSenderStatusAction,
  unsubscribeSenderAction,
} from "@/utils/actions/unsubscriber";
import {
  canonicalizeEmailAddress,
  extractEmailAddress,
  extractNameFromEmail,
} from "@/utils/email";
import { assertActionSucceeded, captureException } from "@/utils/error";
import { NewsletterStatus } from "@/generated/prisma/enums";
import {
  getHttpUnsubscribeLink,
  getUserFacingUnsubscribeLink,
} from "@/utils/parse/unsubscribe";
import type { ParsedMessage } from "@/utils/types";
import { createSearchParams } from "@/utils/url";

// Unreadable filters that look like a passing error are asked for again a few
// times, then left until the person next asks.
const FILTERS_RETRY_DELAYS_MS = [5000, 15_000, 45_000];
// After the filters were refused for now, a person opening the menu again
// does not ask Gmail again straight away.
const FILTERS_ASK_AGAIN_MS = 15_000;
// Shared by every reader and row reading the same sender, so their retries
// add up to one budget rather than one each.
const filtersRetries = new Map<string, { count: number; pending: boolean }>();

/**
 * Sender actions shared by the mail list and reader.
 *
 * The message's `List-Unsubscribe` header is available immediately. When the
 * sender is targeted, the client also checks the sender stats used by bulk unsubscribe
 * so a previously indexed link from the message body remains available here.
 *
 * A one-click header is unsubscribed server-side and the sender is marked; when
 * that fails, or when the sender only offers a mailto, the user gets the link.
 */
export function useUnsubscribeSender(
  message: Pick<ParsedMessage, "headers" | "threadId"> | null,
) {
  const { emailAccountId } = useAccount();
  const { hasUnsubscribeAccess, mutate: refetchPremium } = usePremium();
  const { PremiumModal, openModal } = usePremiumModal();
  const { queueArchiveSenders } = useArchiveSenderQueueActions(emailAccountId);
  const [updatedAutoArchive, setUpdatedAutoArchive] = useState<{
    sender: string;
    enabled: boolean;
  } | null>(null);
  const [isUpdatingAutoArchive, setIsUpdatingAutoArchive] = useState(false);
  const [isConfirmingUnsubscribe, setIsConfirmingUnsubscribe] = useState(false);

  const listUnsubscribeHeader = message?.headers["list-unsubscribe"] ?? null;
  const from = message?.headers.from ?? "";
  const senderEmail = extractEmailAddress(from);
  const senderName = extractNameFromEmail(from);
  const senderStatsUrl = senderEmail ? getSenderStatsUrl(senderEmail) : null;
  const [askedFor, setAskedFor] = useState<string | null>(null);
  const askedForFilters =
    senderStatsUrl !== null && askedFor === senderStatsUrl;
  const {
    data: passiveStats,
    mutate: refetchPassiveStats,
    isLoading: isSenderStatsLoading,
  } = usePassiveSenderStats(senderStatsUrl, emailAccountId);
  // Read only once a person's own action needs the filters the passive read
  // could not give, so it alone may go ahead of background work.
  const { data: askedStats, mutate: refetchAskedStats } =
    useSWR<NewsletterStatsResponse>(
      askedForFilters && senderEmail
        ? [getSenderStatsUrl(senderEmail, true), emailAccountId]
        : null,
      { revalidateOnFocus: false, revalidateOnReconnect: false },
    );
  const senderStats =
    passiveStats?.filtersAvailable === false
      ? (askedStats ?? passiveStats)
      : passiveStats;
  const refetchSenderStats = useCallback(
    () =>
      Promise.all([
        refetchPassiveStats(),
        askedForFilters ? refetchAskedStats() : undefined,
      ]),
    [askedForFilters, refetchAskedStats, refetchPassiveStats],
  );
  const canonicalSenderEmail = canonicalizeEmailAddress(senderEmail);
  const sender = senderStats?.newsletters.find(
    (sender) => sender.name === canonicalSenderEmail,
  );
  const unsubscribeLink = sender?.unsubscribeLink;
  const httpLink = getHttpUnsubscribeLink({
    unsubscribeLink,
    listUnsubscribeHeader,
  });
  const userFacingLink = getUserFacingUnsubscribeLink({
    unsubscribeLink,
    listUnsubscribeHeader,
  });
  const canUnsubscribe = Boolean(senderEmail && userFacingLink);
  const updatedAutoArchiveEnabled =
    updatedAutoArchive?.sender === canonicalSenderEmail
      ? updatedAutoArchive.enabled
      : undefined;
  const isAutoArchivedInDb =
    senderStats?.searchedSenderStatus === NewsletterStatus.AUTO_ARCHIVED;
  const isAutoArchived =
    updatedAutoArchiveEnabled ??
    (isAutoArchivedInDb || Boolean(sender?.autoArchived));
  // Unreadable provider filters leave the status unknown, so hold the toggle
  // rather than show off for a sender that may be skipping the inbox.
  const isFilterStatusUnknown =
    senderStats?.filtersAvailable === false && !isAutoArchivedInDb;
  const isAutoArchiveStatusLoading = Boolean(
    senderEmail && !senderStats && updatedAutoArchiveEnabled === undefined,
  );
  const isAutoArchiveStatusUnknown = Boolean(
    senderEmail &&
      isFilterStatusUnknown &&
      updatedAutoArchiveEnabled === undefined,
  );

  const lastAskAt = useRef(0);
  const loadSenderFilters = useCallback(() => {
    // The passive read is still on its way; it may well answer.
    if (!senderStatsUrl || isSenderStatsLoading || !passiveStats) return;
    if (passiveStats.filtersAvailable !== false) return;
    const current = askedStats ?? passiveStats;
    if (current.filtersAvailable !== false) return;
    if (current.filtersFailure === "permanent") return;
    const now = Date.now();
    if (
      current.filtersFailure === "throttled" &&
      askedStats &&
      now - lastAskAt.current < FILTERS_ASK_AGAIN_MS
    )
      return;
    lastAskAt.current = now;
    if (askedForFilters) refetchAskedStats().catch(captureException);
    else setAskedFor(senderStatsUrl);
  }, [
    askedForFilters,
    askedStats,
    isSenderStatsLoading,
    passiveStats,
    refetchAskedStats,
    senderStatsUrl,
  ]);

  // State lags a fast double-click, so a ref decides whether one is in flight.
  const isTogglingAutoArchive = useRef(false);

  const onToggleAutoArchive = useCallback(async () => {
    if (
      !senderEmail ||
      isAutoArchiveStatusLoading ||
      isUpdatingAutoArchive ||
      isTogglingAutoArchive.current
    )
      return;

    if (isAutoArchiveStatusUnknown) {
      loadSenderFilters();
      return;
    }

    if (!isAutoArchived && !hasUnsubscribeAccess) {
      openModal();
      return;
    }

    isTogglingAutoArchive.current = true;
    setIsUpdatingAutoArchive(true);
    const recordedStatus = senderStats?.searchedSenderStatus ?? null;
    const previousStatus =
      recordedStatus === NewsletterStatus.AUTO_ARCHIVED ? null : recordedStatus;
    const toastId = toast.loading(
      `${isAutoArchived ? "Disabling" : "Enabling"} auto archive for ${senderName}`,
    );

    try {
      const result = await setSenderStatusAction(emailAccountId, {
        senderEmail,
        status: isAutoArchived ? null : NewsletterStatus.AUTO_ARCHIVED,
      });
      assertActionSucceeded(result);
      refetchSenderStats().catch(captureException);
      setUpdatedAutoArchive({
        sender: canonicalSenderEmail,
        enabled: !isAutoArchived,
      });
    } catch (error) {
      captureException(error);
      toast.error(
        `Couldn't ${isAutoArchived ? "disable" : "enable"} auto archive for ${senderName}`,
        { id: toastId },
      );
      return;
    } finally {
      isTogglingAutoArchive.current = false;
      setIsUpdatingAutoArchive(false);
    }

    if (isAutoArchived) {
      toast.success(`Future emails from ${senderName} will stay in the inbox`, {
        id: toastId,
      });
      return;
    }

    // Undo only reverses the filter: mail already archived stays archived.
    toast.dismiss(toastId);
    toastUndo({
      // Its own id, so it doesn't replace a pending archive or send undo.
      id: "block-sender-undo",
      message: `Future emails from ${senderName} will be archived`,
      onUndo: async () => {
        try {
          const undone = await setSenderStatusAction(emailAccountId, {
            senderEmail,
            status: previousStatus,
          });
          assertActionSucceeded(undone);
          refetchSenderStats().catch(captureException);
          setUpdatedAutoArchive({
            sender: canonicalSenderEmail,
            enabled: false,
          });
        } catch (error) {
          captureException(error);
          toast.error(`Couldn't undo auto archive for ${senderName}`);
        }
      },
    });

    // These follow-up tasks do not change the provider filter that was just
    // committed, so their failures must not report the enable as unsuccessful.
    queueArchiveSenders({ senders: [senderEmail] }).catch(captureException);
    decrementUnsubscribeCreditAction()
      .then(() => refetchPremium())
      .catch(captureException);
  }, [
    canonicalSenderEmail,
    refetchSenderStats,
    senderStats?.searchedSenderStatus,
    emailAccountId,
    hasUnsubscribeAccess,
    isAutoArchived,
    isAutoArchiveStatusLoading,
    isAutoArchiveStatusUnknown,
    isUpdatingAutoArchive,
    loadSenderFilters,
    openModal,
    queueArchiveSenders,
    refetchPremium,
    senderEmail,
    senderName,
  ]);

  const onUnsubscribe = useCallback(async () => {
    if (
      !senderEmail ||
      isUpdatingAutoArchive ||
      (isSenderStatsLoading && !httpLink)
    )
      return;
    if (!canUnsubscribe) {
      if (isAutoArchiveStatusLoading) return;
      if (!isAutoArchived) await onToggleAutoArchive();
      return;
    }
    if (!userFacingLink) return;

    if (!hasUnsubscribeAccess) {
      openModal();
      return;
    }

    // Sending the user to a mailto they have to compose is the last resort: an
    // http link opens a page that finishes the job, so it wins when both exist.
    if (!httpLink) {
      openUnsubscribePage(userFacingLink);
      return;
    }

    setIsConfirmingUnsubscribe(true);
  }, [
    canUnsubscribe,
    isSenderStatsLoading,
    isAutoArchiveStatusLoading,
    isUpdatingAutoArchive,
    isAutoArchived,
    onToggleAutoArchive,
    hasUnsubscribeAccess,
    httpLink,
    openModal,
    senderEmail,
    userFacingLink,
  ]);

  const confirmUnsubscribe = useCallback(async () => {
    if (!senderEmail || !httpLink) return;
    await unsubscribeAndArchiveSender({
      emailAccountId,
      senderEmail,
      senderName,
      unsubscribeLink,
      listUnsubscribeHeader,
      manualLink: httpLink,
      queueArchiveSenders,
      refetchPremium,
    });
  }, [
    emailAccountId,
    httpLink,
    listUnsubscribeHeader,
    refetchPremium,
    senderEmail,
    senderName,
    unsubscribeLink,
    queueArchiveSenders,
  ]);

  return {
    isUnsubscribeDisabled:
      isUpdatingAutoArchive ||
      (isSenderStatsLoading && !httpLink) ||
      (!canUnsubscribe && (isAutoArchiveStatusLoading || isAutoArchived)),
    unsubscribeLabel: canUnsubscribe
      ? "Unsubscribe from sender"
      : isAutoArchived
        ? "Sender blocked"
        : "Block sender",
    canManageAutoArchive: Boolean(senderEmail),
    isAutoArchived,
    isAutoArchiveStatusLoading,
    isAutoArchiveStatusUnknown,
    isUpdatingAutoArchive,
    loadSenderFilters,
    onToggleAutoArchive,
    onUnsubscribe,
    PremiumModal,
    unsubscribeConfirm: {
      open: isConfirmingUnsubscribe,
      onOpenChange: setIsConfirmingUnsubscribe,
      senderName,
      onConfirm: confirmUnsubscribe,
    },
  };
}

export function UnsubscribeConfirmDialog({
  open,
  onOpenChange,
  senderName,
  onConfirm,
}: ReturnType<typeof useUnsubscribeSender>["unsubscribeConfirm"]) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Unsubscribe from {senderName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Cue will send an unsubscribe request to {senderName} and archive
            their emails. The request can't be undone from Cue.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>Unsubscribe</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

/**
 * Sends the unsubscribe request, then archives the sender's mail and meters
 * the credit, with a toast that offers the sender's own page if it fails.
 * Resolves whether the sender was unsubscribed.
 */
export async function unsubscribeAndArchiveSender({
  emailAccountId,
  senderEmail,
  senderName,
  unsubscribeLink,
  listUnsubscribeHeader,
  manualLink,
  queueArchiveSenders,
  refetchPremium,
}: {
  emailAccountId: string;
  senderEmail: string;
  senderName: string;
  unsubscribeLink?: string | null;
  listUnsubscribeHeader?: string | null;
  /** The page offered when the request fails. */
  manualLink: string;
  queueArchiveSenders: (input: { senders: string[] }) => Promise<unknown>;
  refetchPremium: () => Promise<unknown>;
}) {
  const toastId = toast.loading(`Unsubscribing from ${senderName}`);
  const failed = () => {
    toast.error(`Couldn't unsubscribe from ${senderName}`, {
      id: toastId,
      action: {
        label: "Open page",
        onClick: () => openUnsubscribePage(manualLink),
      },
    });
    return false;
  };

  try {
    const result = await unsubscribeSenderAction(emailAccountId, {
      senderEmail,
      unsubscribeLink,
      listUnsubscribeHeader,
    });
    if (!result?.data?.unsubscribe.success) return failed();
  } catch {
    return failed();
  }

  toast.success(`Unsubscribed from ${senderName}`, { id: toastId });

  queueArchiveSenders({ senders: [senderEmail] }).catch(() => {});

  // Metering happens after the fact, and neither half changes what the user
  // just saw: a failure here must not read as a failed unsubscribe.
  decrementUnsubscribeCreditAction()
    .then(() => refetchPremium())
    .catch(() => {});
  return true;
}

export function openUnsubscribePage(link: string) {
  window.open(link, "_blank", "noopener,noreferrer");
}

/**
 * The sender's stats read in the background. A failure that looks like a
 * passing error is asked for again a few times; one retry is counted for each
 * read that fails, however often the component renders.
 */
export function usePassiveSenderStats(
  senderStatsUrl: string | null,
  emailAccountId: string,
) {
  const { mutate } = useSWRConfig();
  const key = senderStatsUrl ? [senderStatsUrl, emailAccountId] : null;
  return useSWR<NewsletterStatsResponse>(key, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    onSuccess: (latest) => {
      if (!key) return;
      scheduleFiltersRetry(key.join("\u0000"), latest, () => mutate(key));
    },
  });
}

function scheduleFiltersRetry(
  retryKey: string,
  latest: NewsletterStatsResponse,
  refetch: () => Promise<unknown>,
) {
  if (latest.filtersFailure !== "error") {
    filtersRetries.delete(retryKey);
    return;
  }
  const entry = filtersRetries.get(retryKey) ?? { count: 0, pending: false };
  filtersRetries.set(retryKey, entry);
  const delay = filtersRetryDelayMs(latest, entry.count);
  if (delay === 0 || entry.pending) return;
  entry.count += 1;
  entry.pending = true;
  setTimeout(() => {
    entry.pending = false;
    refetch().catch(captureException);
  }, delay);
}

function getSenderStatsUrl(senderEmail: string, interactive = false) {
  return `/api/user/stats/newsletters?${createSearchParams({
    types: [],
    search: senderEmail,
    orderBy: "emails",
    orderDirection: "desc",
    includeMissingUnsubscribe: true,
    ...(interactive ? { interactive: true } : {}),
  })}`;
}

/**
 * How long until the passive read asks again, or 0 to stop. Only a failure
 * that looks like a passing error is retried: a refused grant needs the
 * person, and a refusal for now is only deepened by asking again.
 */
function filtersRetryDelayMs(
  latest: Pick<NewsletterStatsResponse, "filtersFailure"> | undefined,
  retriesSoFar: number,
) {
  if (latest?.filtersFailure !== "error") return 0;
  return FILTERS_RETRY_DELAYS_MS[retriesSoFar] ?? 0;
}
