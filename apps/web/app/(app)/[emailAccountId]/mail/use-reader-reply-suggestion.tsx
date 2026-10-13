"use client";

import { ReplyIcon } from "lucide-react";
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
 * its newest message isn't from the user and it has no draft. The founder's
 * rule: only if we have the context to reply, but if we do, write it.
 */
export const AUTO_SUGGEST = true;

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
  enabled,
  onOpenThread,
  onReply,
}: {
  emailAccountId: string;
  threadId: string | null;
  messages: ThreadMessage[];
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
  const [decision, setDecision] = useState<{ id: string; run: boolean }>();
  if (latest && decision?.id !== latest.id) {
    setDecision({
      id: latest.id,
      run: AUTO_SUGGEST && !latestIsFromUser && !hasDraft,
    });
  }
  const run = Boolean(latest && decision?.id === latest.id && decision.run);
  const { phase, suggestion } = useReplySuggestion({
    threadId,
    emailAccountId,
    enabled: enabled && run,
  });

  const assist: ReplyAssist | null =
    latest && suggestion?.status === "suggested"
      ? {
          messageId: latest.id,
          suggestedBodyHtml: textToHtmlParagraphs(suggestion.reply),
          footer: (
            <CheckedAgainst
              citations={suggestion.citations}
              onOpenThread={onOpenThread}
            />
          ),
        }
      : null;

  let idleReplyArea: React.ReactNode = null;
  if (latest && (phase === "checking-mail" || phase === "checking-web")) {
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
  } else if (latest && suggestion?.status === "insufficient") {
    idleReplyArea = (
      <ReplyArea>
        <div className="fade-in flex animate-in flex-wrap items-center gap-x-3 gap-y-1 duration-150">
          <Button
            onClick={() => onReply(latest.id)}
            size="sm"
            type="button"
            variant="outline"
          >
            <ReplyIcon className="mr-2 size-4" />
            Reply
          </Button>
          <p className="text-muted-foreground text-xs">
            {abstentionLine(suggestion.missing)}
          </p>
        </div>
      </ReplyArea>
    );
  }

  return { assist, idleReplyArea };
}

function ReplyArea({ children }: { children: React.ReactNode }) {
  return <div className="px-2 pt-1 pb-4 sm:pr-5 sm:pl-14">{children}</div>;
}
