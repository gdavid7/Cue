"use client";

import { useMemo, useState } from "react";
import type { GetThreadPlansResponse } from "@/app/api/user/thread-plans/route";
import { useDraftReplies } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies";
import { getThreadCategories } from "@/app/(app)/[emailAccountId]/mail/cue-strip";
import { getReaderReplyGate } from "@/app/(app)/[emailAccountId]/mail/reader-reply-gate";
import type { ThreadMessage } from "@/components/email-list/types";
import type { ReplyAssist } from "@/components/email-list/reply-assist";
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
import { threadInsightItem, useInboxInsights } from "@/hooks/useInboxInsights";
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
import { GmailLabel } from "@/utils/gmail/label";
import { dismissReplySuggestionAction } from "@/utils/actions/thread-assist";

const NO_PLANS: never[] = [];

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
  }>();
  const gate = getReaderReplyGate({
    setting: draftReplies.setting,
    settingLoading: draftReplies.loading,
    hasLatest: Boolean(latest),
    latestIsFromUser,
    hasDraft,
  });
  if (latest && decision?.id !== latest.id && !draftReplies.loading) {
    setDecision({ id: latest.id, eligible: gate.autoEligible, run: false });
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
  const { data: insights, isLoading: insightLoading } =
    useInboxInsights(insightItems);
  const insight = threadId ? insights?.[threadId] : undefined;
  const needsReply =
    filedToReply ||
    insight?.insight?.action === "reply" ||
    Boolean(insight?.reply);
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
  const dismissRuleSuggestion = (executedActionId: string) => {
    mutatePlans(
      (data) =>
        data && { plans: withoutSuggestion(data.plans, executedActionId) },
      { revalidate: false },
    );
    dismissReplySuggestionAction(emailAccountId, { executedActionId })
      .then((result) => {
        if (result?.serverError) throw new Error(result.serverError);
      })
      .catch(() => {
        mutatePlans();
        toastError({ description: "Couldn’t dismiss Cue’s reply. Try again." });
      });
  };

  const run = Boolean(current?.run);
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
    if (!latest || !canRequestReply || !writesReplies || run) return;
    setDecision({ id: latest.id, eligible: true, run: true });
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
  // Gathering the context is the first part of checking the user's mail.
  const phase =
    enabled && run && !ruleSuggestion && !contextSettled
      ? "checking-mail"
      : replySuggestion.phase;

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
    const toSomeoneElse =
      recipients.to &&
      !splitRecipientList(recipients.to).every((recipient) =>
        isSameEmailAddress(extractEmailAddress(recipient), sender),
      );
    assist = {
      messageId: latest.id,
      reply: ruleSuggestion.reply,
      evidence: null,
      executedActionId,
      dismiss: () => dismissRuleSuggestion(executedActionId),
      recipients,
      files,
      label: toSomeoneElse ? `Cue's draft to ${recipients.to}` : undefined,
    };
  }

  let replyStatus: React.ReactNode = null;
  if (latest && (phase === "checking-mail" || phase === "checking-web")) {
    replyStatus = (
      <p className="text-muted-foreground text-xs" role="status">
        {suggestionPhaseLabel(phase)}
      </p>
    );
  } else if (latest && suggestion?.status === "insufficient") {
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
 * The reply a rule wrote for the message, waiting in Cue: drafted, not yet
 * used, dismissed or superseded, and never put in the mailbox.
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
    if (!action?.content) continue;
    return {
      executedActionId: action.id,
      reply: action.content.trim(),
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
