"use client";

import { ReplyIcon } from "lucide-react";
import { useMemo, useState } from "react";
import type { ThreadMessage } from "@/components/email-list/types";
import type { ReplyAssist } from "@/components/email-list/reply-assist";
import {
  abstentionLine,
  CheckedAgainst,
  suggestionPhaseLabel,
} from "@/components/thread-context/SuggestedReply";
import { Button } from "@/components/ui/button";
import { SystemType } from "@/generated/prisma/enums";
import { useInboxInsights } from "@/hooks/useInboxInsights";
import { useReplySuggestion } from "@/hooks/useReplySuggestion";
import { useSuggestedReply } from "@/hooks/useSuggestedReply";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { EmailLabels } from "@/providers/email-label-types";
import { extractEmailAddress, isSameEmailAddress } from "@/utils/email";
import { GmailLabel } from "@/utils/gmail/label";
import { getRuleLabel } from "@/utils/rule/consts";

/**
 * Write the suggested reply as soon as a conversation that needs one opens:
 * its newest message isn't from the user, it has no draft, and it is waiting
 * on a reply. The founder's rule: only if we have the context to reply, but
 * if we do, write it.
 */
export const AUTO_SUGGEST = true;

const TO_REPLY_LABEL = getRuleLabel(SystemType.TO_REPLY);

/**
 * Cue's suggested reply for the open conversation, delivered where the user
 * would reply anyway: the reply composer, pre-filled, and only when every fact
 * in it is backed. Otherwise `idleReplyArea` says in one line why Cue left
 * the reply to the user, beside the normal Reply button.
 */
export function useReaderReplySuggestion({
  emailAccountId,
  threadId,
  messages,
  userLabels,
  enabled,
  onOpenThread,
  onReply,
}: {
  emailAccountId: string;
  threadId: string | null;
  messages: ThreadMessage[];
  /** Label id to label, to tell whether the conversation is To Reply. */
  userLabels: EmailLabels;
  /** False while keyboard navigation is still moving through threads. */
  enabled: boolean;
  onOpenThread: (threadId: string) => void;
  /** Opens an empty reply to the newest message. */
  onReply: (messageId: string) => void;
}) {
  const { userEmail } = useAccount();
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
  // turn the suggestion off.
  const [decision, setDecision] = useState<{
    id: string;
    eligible: boolean;
    run: boolean;
  }>();
  if (latest && decision?.id !== latest.id) {
    setDecision({
      id: latest.id,
      eligible: AUTO_SUGGEST && !latestIsFromUser && !hasDraft,
      run: false,
    });
  }
  const current = latest && decision?.id === latest.id ? decision : undefined;

  // Only mail waiting on a reply gets one: the rules filed it To Reply, or
  // Cue's read of the newest message says the sender is waiting, or Cue has
  // already tried a reply to it.
  const hasToReplyLabel = messages.some((message) =>
    message.labelIds?.some((id) => userLabels[id]?.name === TO_REPLY_LABEL),
  );
  const latestId = latest?.id;
  const insightItems = useMemo(
    () =>
      current?.eligible && !hasToReplyLabel && threadId && latestId
        ? [{ key: threadId, emailAccountId, threadId, messageId: latestId }]
        : [],
    [current?.eligible, hasToReplyLabel, threadId, latestId, emailAccountId],
  );
  const { data: insights } = useInboxInsights(insightItems);
  const insight = threadId ? insights?.[threadId] : undefined;
  const needsReply =
    hasToReplyLabel ||
    insight?.insight?.action === "reply" ||
    Boolean(insight?.reply);
  if (current?.eligible && !current.run && needsReply) {
    setDecision({ ...current, run: true });
  }

  const run = Boolean(current?.run);
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

  // Reply is there from the start: checking must never stand in the way of
  // the user writing the reply themselves.
  let idleReplyArea: React.ReactNode = null;
  if (latest && (phase === "checking-mail" || phase === "checking-web")) {
    idleReplyArea = (
      <ReplyArea onReply={() => onReply(latest.id)}>
        <p className="text-muted-foreground text-xs" role="status">
          {suggestionPhaseLabel(phase)}
        </p>
      </ReplyArea>
    );
  } else if (latest && suggestion?.status === "insufficient") {
    idleReplyArea = (
      <ReplyArea onReply={() => onReply(latest.id)}>
        <p className="fade-in animate-in text-muted-foreground text-xs duration-150">
          {abstentionLine(suggestion.missing)}
        </p>
      </ReplyArea>
    );
  }

  return { assist, idleReplyArea };
}

function ReplyArea({
  onReply,
  children,
}: {
  onReply: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="px-2 pt-1 pb-4 sm:pr-5 sm:pl-14">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <Button onClick={onReply} size="sm" type="button" variant="outline">
          <ReplyIcon className="mr-2 size-4" />
          Reply
        </Button>
        {children}
      </div>
    </div>
  );
}
