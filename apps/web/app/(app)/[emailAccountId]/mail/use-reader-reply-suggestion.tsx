"use client";

import { useMemo, useState } from "react";
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
import { SystemType } from "@/generated/prisma/enums";
import { threadInsightItem, useInboxInsights } from "@/hooks/useInboxInsights";
import { useReplySuggestion } from "@/hooks/useReplySuggestion";
import { useSuggestedReply } from "@/hooks/useSuggestedReply";
import { useThreadPlans } from "@/hooks/useThreadPlans";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { EmailLabels } from "@/providers/email-label-types";
import { extractEmailAddress, isSameEmailAddress } from "@/utils/email";
import { GmailLabel } from "@/utils/gmail/label";

const NO_PLANS: never[] = [];

/**
 * Cue's suggested reply for the open conversation, delivered where the user
 * would reply anyway: the reply composer, pre-filled, and only when every fact
 * in it is backed. Otherwise `replyStatus` says in one line, under the usual
 * reply actions, what Cue is doing or why it left the reply to the user.
 *
 * It writes one as soon as a conversation that needs one opens: its newest
 * message isn't from the user, it has no draft, it is waiting on a reply, and
 * the user has "Auto draft replies" on. Otherwise `reply.offer` says to show
 * a "Draft a reply" button, unless the user turned drafting off.
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
  const { data: planData, error: plansError } = useThreadPlans({
    threadId: enabled && current?.eligible ? threadId : null,
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
  if (current?.eligible && !current.run && needsReply) {
    setDecision({ ...current, run: true });
  }

  const run = Boolean(current?.run);
  // Asked for by the user, so it runs for any message someone else sent,
  // whether or not Cue thinks it needs a reply, and whether or not "Auto
  // draft replies" was ever turned on. Turned off still means no AI-written
  // reply at all; the server enforces it too.
  const { canRequest: canRequestReply, writesReplies } = gate;
  const requestReply = () => {
    if (!latest || !canRequestReply || !writesReplies || run) return;
    setDecision({ id: latest.id, eligible: true, run: true });
  };
  const { phase, suggestion } = useReplySuggestion({
    threadId,
    emailAccountId,
    enabled: enabled && run,
  });

  // Reopened with a draft: the suggestion Cue made for this message, if any,
  // so a draft that is still Cue's text keeps saying so.
  const { data: saved } = useSuggestedReply({
    threadId,
    emailAccountId,
    enabled: enabled && !run && !latestIsFromUser && hasDraft,
    cachedFor: latestId,
  });
  const latestSuggestion = suggestion ?? saved?.suggestion;
  const verified =
    latestSuggestion?.status === "suggested" ? latestSuggestion : undefined;

  const assist: ReplyAssist | null =
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
        !(current?.eligible && (!plansSettled || insightLoading)),
      request: requestReply,
      /**
       * The newest message once there's nothing to wait for: its suggestion
       * settled either way, or Cue doesn't write replies for this account.
       */
      settledFor:
        (run && phase === "done") || !writesReplies ? latest?.id : undefined,
    },
  };
}
