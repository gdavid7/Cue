"use client";

import { SparklesIcon } from "lucide-react";
import { useState } from "react";
import type { ThreadMessage } from "@/components/email-list/types";
import type { ReplyAssist } from "@/components/email-list/reply-assist";
import {
  abstentionLine,
  CheckedAgainst,
  suggestionPhaseLabel,
} from "@/components/thread-context/SuggestedReply";
import { Button } from "@/components/ui/button";
import { useReplySuggestion } from "@/hooks/useReplySuggestion";
import { useAccount } from "@/providers/EmailAccountProvider";
import { extractEmailAddress, isSameEmailAddress } from "@/utils/email";
import { GmailLabel } from "@/utils/gmail/label";
import { textToHtmlParagraphs } from "@/utils/string";

/**
 * Write the suggested reply as soon as a conversation that needs one opens:
 * its newest message isn't from the user and it has no draft. Off until the
 * founder approves running a model call on every open.
 */
export const AUTO_SUGGEST = false;

/**
 * Cue's suggested reply for the open conversation, delivered where the user
 * would reply anyway: the reply composer, pre-filled. `idleReplyArea` sits
 * after the thread while nothing is being written.
 */
export function useReaderReplySuggestion({
  emailAccountId,
  threadId,
  messages,
  enabled,
  onOpenThread,
}: {
  emailAccountId: string;
  threadId: string | null;
  messages: ThreadMessage[];
  /** False while keyboard navigation is still moving through threads. */
  enabled: boolean;
  onOpenThread: (threadId: string) => void;
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
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  const requested =
    Boolean(latest) &&
    ((AUTO_SUGGEST && !latestIsFromUser && !hasDraft) ||
      requestedFor === latest?.id);
  const { phase, suggestion } = useReplySuggestion({
    threadId,
    emailAccountId,
    enabled: enabled && requested,
  });

  let assist: ReplyAssist | null = null;
  if (latest && suggestion?.status === "suggested") {
    assist = {
      messageId: latest.id,
      suggestedBodyHtml: textToHtmlParagraphs(suggestion.reply),
      footer: (
        <CheckedAgainst
          citations={suggestion.citations}
          onOpenThread={onOpenThread}
        />
      ),
    };
  } else if (latest && suggestion?.status === "insufficient") {
    assist = {
      messageId: latest.id,
      footer: (
        <p className="text-muted-foreground text-xs">
          {abstentionLine(suggestion.missing)}
        </p>
      ),
    };
  }

  let idleReplyArea: React.ReactNode = null;
  if (latest && !latestIsFromUser) {
    if (phase === "checking-mail" || phase === "checking-web") {
      idleReplyArea = (
        <ReplyArea>
          <p
            className="fade-in animate-in text-muted-foreground text-sm duration-150"
            role="status"
          >
            {suggestionPhaseLabel(phase)}
          </p>
        </ReplyArea>
      );
    } else if (!requested) {
      idleReplyArea = (
        <ReplyArea>
          <Button
            onClick={() => setRequestedFor(latest.id)}
            size="sm"
            type="button"
            variant="ghostMuted"
          >
            <SparklesIcon className="mr-2 size-4" />
            Suggest a reply
          </Button>
        </ReplyArea>
      );
    }
  }

  return { assist, idleReplyArea };
}

function ReplyArea({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-4 sm:pr-5 sm:pl-14">{children}</div>;
}
