"use client";

import { useEffect, useMemo, useState } from "react";
import type { GetThreadPlansResponse } from "@/app/api/user/thread-plans/route";
import { useDraftReplies } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies";
import {
  getThreadCategories,
  isFromPerson,
} from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import { getReaderReplyGate } from "@/app/(app)/[emailAccountId]/mail/reader-reply-gate";
import type { ThreadMessage } from "@/components/email-list/types";
import {
  draftHtmlToReplyText,
  type ReplyAssist,
} from "@/components/email-list/reply-assist";
import {
  abstentionLine,
  CheckedAgainst,
  suggestionPhaseLabel,
} from "@/components/thread-context/SuggestedReply";
import { toastError } from "@/components/Toast";
import {
  ActionType,
  AttachmentSourceType,
  DraftEmailStatus,
  SystemType,
} from "@/generated/prisma/enums";
import {
  refreshInboxInsights,
  threadInsightItem,
  useInboxInsights,
} from "@/hooks/useInboxInsights";
import { useReplySuggestion } from "@/hooks/useReplySuggestion";
import { useSuggestedReply } from "@/hooks/useSuggestedReply";
import { useThreadPlans } from "@/hooks/useThreadPlans";
import { contextWithText, useThreadContext } from "@/hooks/useThreadContext";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { EmailLabels } from "@/providers/email-label-types";
import {
  extractEmailAddress,
  isSameEmailAddress,
  splitRecipientList,
} from "@/utils/email";
import { DRAFT_WINDOW_DAYS } from "@/utils/reply-tracker/suggestion-window";
import {
  beginRumAction,
  cancelRumAction,
  completeRumAction,
} from "@/utils/analytics/rum-actions";
import { GmailLabel } from "@/utils/gmail/label";
import {
  dismissReplySuggestionAction,
  recordReplySuggestionStageAction,
} from "@/utils/actions/thread-assist";

const NO_PLANS: never[] = [];
// How long the reader waits on a reply before it says it couldn't write one
// and offers to try again, rather than spinning for as long as Gmail is busy.
export const REPLY_WAIT_LIMIT_MS = 15_000;
// The user's rules write their reply to fresh mail while the reader works out
// its own, and can finish seconds after the reader settled. For mail that
// just arrived, the reader keeps checking for the rule's reply this often,
// for this long after it opened, and no longer.
export const RULE_REPLY_POLL_INTERVAL_MS = 2000;
export const RULE_REPLY_POLL_LIMIT_MS = 30_000;
const FRESH_MAIL_MS = 2 * 60 * 1000;

/**
 * Cue's suggested reply for the open conversation, delivered where the user
 * would reply anyway: the reply composer, pre-filled, and only when every fact
 * in it is backed. Otherwise `replyStatus` says in one line, under the usual
 * reply actions, what Cue is doing or why it left the reply to the user.
 *
 * A reply the user's rules already wrote comes first: it is ready at once,
 * waiting in Cue rather than in the mailbox, and becomes a mailbox draft only
 * once the user edits it. Without one, Cue writes one as soon as a
 * conversation that needs one opens: its newest message isn't from the user,
 * it has no draft, it is waiting on a reply, and the user has "Auto draft
 * replies" on. Otherwise `reply.offer` says to show a "Draft a reply" button,
 * unless the user turned drafting off.
 */
export function useReaderReplySuggestion({
  emailAccountId,
  threadId,
  messages,
  userLabels,
  enabled,
  onOpenThread,
}: {
  emailAccountId: string;
  threadId: string | null;
  messages: ThreadMessage[];
  /** Label id to label, to tell whether the conversation is To Reply. */
  userLabels: EmailLabels;
  /** False while keyboard navigation is still moving through threads. */
  enabled: boolean;
  onOpenThread: (threadId: string) => void;
}) {
  const { userEmail } = useAccount();
  const draftReplies = useDraftReplies();
  const latest = messages.findLast(
    (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
  );
  const latestIsFromUser =
    !latest ||
    Boolean(latest.labelIds?.includes(GmailLabel.SENT)) ||
    isSameEmailAddress(extractEmailAddress(latest.headers.from), userEmail);
  const hasDraft = messages.some((message) =>
    message.labelIds?.includes(GmailLabel.DRAFT),
  );
  // Decided once per newest message: the draft a suggestion saves must not
  // turn the suggestion off. It waits for the setting rather than reading a
  // setting that is still loading as off.
  const [decision, setDecision] = useState<{
    id: string;
    eligible: boolean;
    run: boolean;
    /** Until when a rule's reply may still be on its way, for fresh mail. */
    ruleReplyDueBy?: number;
  }>();
  const gate = getReaderReplyGate({
    setting: draftReplies.setting,
    settingLoading: draftReplies.loading,
    hasLatest: Boolean(latest),
    latestIsFromUser,
    hasDraft,
  });
  if (latest && decision?.id !== latest.id && !draftReplies.loading) {
    setDecision({
      id: latest.id,
      eligible: gate.autoEligible,
      run: false,
      ruleReplyDueBy: isFreshMail(latest)
        ? Date.now() + RULE_REPLY_POLL_LIMIT_MS
        : undefined,
    });
  }
  const current = latest && decision?.id === latest.id ? decision : undefined;

  // Only mail waiting on a reply gets one: the rules filed it To Reply, or
  // Cue's read of the newest message says the sender is waiting, or Cue has
  // already tried a reply to it. Cue files To Reply in its own database, not
  // as a mailbox label, so the rule's runs count as well as a legacy label.
  // The rule runs also hold the reply a rule already wrote, so they're read
  // for any message someone else sent, not only the ones Cue may answer.
  const {
    data: planData,
    error: plansError,
    mutate: mutatePlans,
  } = useThreadPlans({
    threadId: enabled && !latestIsFromUser ? threadId : null,
    emailAccountId,
  });
  const filedToReply = getThreadCategories({
    messages,
    userLabels,
    plans: planData?.plans ?? NO_PLANS,
  }).has(SystemType.TO_REPLY);
  // The rule's runs answer first; Cue's note is only asked for without them.
  const plansSettled = Boolean(planData || plansError);
  const latestId = latest?.id;
  const insightItems = useMemo(
    () =>
      current?.eligible && plansSettled && !filedToReply && threadId && latestId
        ? [threadInsightItem({ emailAccountId, threadId, messageId: latestId })]
        : [],
    [
      current?.eligible,
      plansSettled,
      filedToReply,
      threadId,
      latestId,
      emailAccountId,
    ],
  );
  const {
    data: insights,
    isLoading: insightLoading,
    error: insightError,
  } = useInboxInsights(insightItems);
  const insight = threadId ? insights?.[threadId] : undefined;
  // Cue's note on the email couldn't be read, as when Gmail keeps deferring
  // it: a person writing to the user is taken to be waiting, so the reply
  // never hangs on that read (DR-4).
  const insightFailed =
    insightItems.length > 0 && !insight && Boolean(insightError);
  const needsReply =
    filedToReply ||
    insight?.insight?.action === "reply" ||
    Boolean(insight?.reply) ||
    (insightFailed && Boolean(latest) && isFromPerson(latest!.headers));
  // Kept once its edit made a draft, so the reply still credits Cue.
  const ruleSuggestion =
    latest && !latestIsFromUser && gate.writesReplies
      ? findRuleSuggestion(planData?.plans, latest.id)
      : undefined;
  // The rule's reply stands in for the one Cue would work out here.
  if (
    current?.eligible &&
    !current.run &&
    needsReply &&
    plansSettled &&
    !ruleSuggestion
  ) {
    setDecision({ ...current, run: true });
  }
  const dismissRuleSuggestion = (
    executedActionId: string,
    dismissedFor: string,
  ) => {
    mutatePlans(
      (data) =>
        data && { plans: withoutSuggestion(data.plans, executedActionId) },
      { revalidate: false },
    );
    dismissReplySuggestionAction(emailAccountId, { executedActionId })
      .then((result) => {
        if (result?.serverError) throw new Error(result.serverError);
        // The inbox row stops saying "Cue drafted a reply".
        refreshInboxInsights(emailAccountId, {
          withoutDraftFor: dismissedFor,
        });
      })
      .catch(() => {
        mutatePlans();
        toastError({ description: "Couldn’t dismiss Cue’s reply. Try again." });
      });
  };

  const run = Boolean(current?.run);
  // Each try has its own clock, so "Try again" waits the full limit again.
  const [attempt, setAttempt] = useState(0);
  const [gaveUpOn, setGaveUpOn] = useState<string>();
  // Opened on its own only while the conversation is in the inbox and the
  // reply is recent; otherwise it waits for "Draft a reply".
  const showRuleSuggestion = Boolean(
    ruleSuggestion &&
      (run ||
        (isInInbox(messages) && isWithinDraftWindow(ruleSuggestion.createdAt))),
  );
  // Asked for by the user, so it runs for any message someone else sent,
  // whether or not Cue thinks it needs a reply, and whether or not "Auto
  // draft replies" was ever turned on. Turned off still means no AI-written
  // reply at all; the server enforces it too.
  const { canRequest: canRequestReply, writesReplies } = gate;
  const requestReply = () => {
    if (!latest || !canRequestReply || !writesReplies) return;
    if (run) {
      if (failed) retry();
      return;
    }
    setDecision({ ...current, id: latest.id, eligible: true, run: true });
  };
  // The same context the reader shows, handed to the suggestion so the server
  // doesn't gather it (and read linked pages) again for each pass.
  const context = useThreadContext({
    threadId: enabled && run && !ruleSuggestion ? threadId : null,
    emailAccountId,
  });
  const contextSettled = Boolean(context.data || context.error);
  const replySuggestion = useReplySuggestion({
    threadId,
    emailAccountId,
    messageId: latestId,
    enabled: enabled && run && !ruleSuggestion && contextSettled,
    context: contextWithText(context.data),
  });
  const { suggestion } = replySuggestion;
  const suggestionAsked = run && Boolean(latestId);
  useEffect(() => {
    if (suggestionAsked) beginRumAction("reply_suggestion", { key: latestId });
    return () => cancelRumAction("reply_suggestion", latestId);
  }, [suggestionAsked, latestId]);
  const suggestionError = Boolean(replySuggestion.error);
  useEffect(() => {
    if (suggestionError) {
      completeRumAction("reply_suggestion", {
        key: latestId,
        outcome: "error",
      });
    } else if (suggestion) {
      completeRumAction("reply_suggestion", {
        key: latestId,
        outcome: suggestion.status === "suggested" ? "ok" : "empty",
      });
    }
  }, [suggestion, suggestionError, latestId]);
  // Gathering the context is the first part of checking the user's mail.
  const phase =
    enabled && run && !ruleSuggestion && !contextSettled
      ? "checking-mail"
      : replySuggestion.phase;
  const checking = phase === "checking-mail" || phase === "checking-web";
  // Still checking, or between the bounded retries of a failed check.
  const waiting =
    enabled &&
    run &&
    !ruleSuggestion &&
    !suggestion &&
    (checking || Boolean(replySuggestion.error));
  const attemptKey = latestId ? `${latestId}:${attempt}` : undefined;
  useEffect(() => {
    if (!waiting || !attemptKey) return;
    const timer = setTimeout(
      () => setGaveUpOn(attemptKey),
      REPLY_WAIT_LIMIT_MS,
    );
    return () => clearTimeout(timer);
  }, [waiting, attemptKey]);
  const failed = waiting && gaveUpOn === attemptKey;
  const retry = () => {
    setAttempt((value) => value + 1);
    if (!context.data) context.mutate?.();
    replySuggestion.retry();
  };

  // Reopened with a draft: the suggestion this browser kept for this message,
  // if any, so a draft that is still Cue's text keeps saying so.
  const { data: saved } = useSuggestedReply({
    threadId,
    emailAccountId,
    messageId: latestId,
    enabled: enabled && !run && !latestIsFromUser && hasDraft && writesReplies,
    keptOnly: true,
  });
  const latestSuggestion = suggestion ?? saved?.suggestion;
  const verified =
    latestSuggestion?.status === "suggested" ? latestSuggestion : undefined;

  // Until the rule's reply lands, fetched again on a short, bounded schedule.
  // Never once the user has a draft or Cue's own checked reply is ready.
  const ruleReplyDueBy =
    enabled &&
    gate.canRequest &&
    writesReplies &&
    needsReply &&
    plansSettled &&
    !ruleSuggestion &&
    !verified &&
    isInInbox(messages)
      ? current?.ruleReplyDueBy
      : undefined;
  useEffect(() => {
    if (!ruleReplyDueBy) return;
    const timer = setInterval(() => {
      if (Date.now() >= ruleReplyDueBy) clearInterval(timer);
      else mutatePlans();
    }, RULE_REPLY_POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [ruleReplyDueBy, mutatePlans]);

  let assist: ReplyAssist | null =
    latest && verified
      ? {
          messageId: latest.id,
          reply: verified.reply,
          evidence: (
            <CheckedAgainst
              citations={verified.citations}
              onOpenThread={onOpenThread}
            />
          ),
        }
      : null;

  // Asked-for help wins; otherwise the rule's reply, ready at once.
  if (!assist && latest && ruleSuggestion && showRuleSuggestion) {
    const { executedActionId, recipients, files } = ruleSuggestion;
    const sender = extractEmailAddress(latest.headers.from);
    // A rule can write to someone else: never pass that off as the reply.
    const toSomeoneElse = Boolean(
      recipients.to &&
        !splitRecipientList(recipients.to).every((recipient) =>
          isSameEmailAddress(extractEmailAddress(recipient), sender),
        ),
    );
    assist = {
      messageId: latest.id,
      reply: ruleSuggestion.reply,
      evidence: null,
      executedActionId,
      dismiss: () => dismissRuleSuggestion(executedActionId, latest.id),
      recipients,
      files,
      toSomeoneElse,
      label: toSomeoneElse ? `Cue's draft to ${recipients.to}` : undefined,
    };
  }

  // The draft funnel's "shown" stage. The server keeps the first time only.
  const shownSuggestionId = assist?.executedActionId;
  useEffect(() => {
    if (!shownSuggestionId) return;
    recordReplySuggestionStageAction(emailAccountId, {
      executedActionId: shownSuggestionId,
      stage: "shown",
    }).catch(() => {
      // Only the funnel's count is lost.
    });
  }, [emailAccountId, shownSuggestionId]);

  let replyStatus: React.ReactNode = null;
  if (latest && failed) {
    replyStatus = (
      <p className="text-muted-foreground text-xs" role="status">
        Couldn't draft a reply right now.{" "}
        <button
          className="rounded-sm font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={retry}
          type="button"
        >
          Try again
        </button>
      </p>
    );
  } else if (latest && checking) {
    replyStatus = (
      <p className="text-muted-foreground text-xs" role="status">
        {suggestionPhaseLabel(phase)}
      </p>
    );
  } else if (latest && !assist && suggestion?.status === "insufficient") {
    // A rule's reply that landed after Cue declined stands on its own.
    replyStatus = (
      <p className="fade-in animate-in text-muted-foreground text-xs duration-150">
        {abstentionLine(suggestion.missing)}
      </p>
    );
  }

  return {
    assist,
    replyStatus,
    reply: {
      canRequest: canRequestReply,
      /**
       * Whether to offer "Draft a reply" under the reply actions: nothing is
       * on its way, and Cue isn't still deciding to write one unasked. Waits
       * for the setting too, so the button appears once rather than flickers.
       */
      offer:
        !draftReplies.loading &&
        canRequestReply &&
        writesReplies &&
        !run &&
        !showRuleSuggestion &&
        !(current?.eligible && (!plansSettled || insightLoading)),
      request: requestReply,
      /** Cue gave up waiting on this reply; `request` tries again. */
      failed,
      /**
       * The newest message once there's nothing to wait for: its suggestion
       * settled either way, or Cue doesn't write replies for this account.
       */
      settledFor:
        (run && phase === "done") || !writesReplies || ruleSuggestion
          ? latest?.id
          : undefined,
    },
  };
}

type ThreadPlan = GetThreadPlansResponse["plans"][number];

/**
 * The reply a rule wrote for the message, or Cue pre-drafted for it, waiting
 * in Cue: drafted, not yet used, dismissed or superseded, and never put in
 * the mailbox.
 */
function findRuleSuggestion(
  plans: ThreadPlan[] | undefined,
  messageId: string,
) {
  for (const plan of plans ?? []) {
    if (plan.messageId !== messageId) continue;
    const action = plan.actionItems.find(
      (item) =>
        item.type === ActionType.DRAFT_EMAIL &&
        !item.draftId &&
        item.draftStatus === DraftEmailStatus.PENDING &&
        item.content?.trim(),
    );
    const reply = action?.content ? draftHtmlToReplyText(action.content) : "";
    if (!action || !reply) continue;
    return {
      executedActionId: action.id,
      reply,
      createdAt: action.createdAt,
      recipients: {
        to: action.to || undefined,
        cc: action.cc || undefined,
        bcc: action.bcc || undefined,
        subject: action.subject || undefined,
      },
      files: attachmentNames(action),
    };
  }
  return;
}

/** The names of the files a rule's reply carries: its own, and the AI's. */
function attachmentNames(action: {
  staticAttachments: unknown;
  selectedAttachments: unknown;
}) {
  const names = [
    // A rule's sources can be folders too; only its files are attached.
    ...namesFrom(action.staticAttachments, "name", AttachmentSourceType.FILE),
    ...namesFrom(action.selectedAttachments, "filename"),
  ];
  return [...new Set(names)];
}

function namesFrom(
  raw: unknown,
  key: "name" | "filename",
  type?: AttachmentSourceType,
) {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    if (type && record.type !== type) return [];
    const name = record[key];
    return typeof name === "string" && name.trim() ? [name.trim()] : [];
  });
}

function isFreshMail(message: ThreadMessage) {
  const receivedAt = message.internalDate
    ? Number(message.internalDate)
    : new Date(message.headers.date).getTime();
  return Number.isFinite(receivedAt) && Date.now() - receivedAt < FRESH_MAIL_MS;
}

function isInInbox(messages: ThreadMessage[]) {
  const latest = messages.findLast(
    (message) => !message.labelIds?.includes(GmailLabel.DRAFT),
  );
  return (
    Boolean(latest?.labelIds?.includes(GmailLabel.INBOX)) &&
    !messages.some(
      (message) =>
        message.labelIds?.includes(GmailLabel.TRASH) ||
        message.labelIds?.includes(GmailLabel.SPAM),
    )
  );
}

function isWithinDraftWindow(createdAt: Date | string) {
  return (
    Date.now() - new Date(createdAt).getTime() <
    DRAFT_WINDOW_DAYS * 24 * 60 * 60 * 1000
  );
}

function withoutSuggestion(plans: ThreadPlan[], executedActionId: string) {
  return plans.map((plan) => ({
    ...plan,
    actionItems: plan.actionItems.map((item) =>
      item.id === executedActionId
        ? { ...item, draftStatus: DraftEmailStatus.DISMISSED }
        : item,
    ),
  }));
}
