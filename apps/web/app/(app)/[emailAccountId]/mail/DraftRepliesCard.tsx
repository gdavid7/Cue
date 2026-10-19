"use client";

import { useState } from "react";
import { useDraftReplies } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies";
import { toastError } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { dismissHintAction } from "@/utils/actions/hints";
import { isInboxStyleCardPending } from "@/utils/split-inbox/inbox-styles";

/**
 * Asks once per mailbox, above the mail list, whether Cue should draft
 * replies, for mailboxes made before drafting was on from the start. Only a
 * mailbox that never chose sees it: one turned off stays off, unasked. The
 * "Auto draft replies" setting keeps the same choice for later.
 */
export function DraftRepliesCard({
  inboxStyleCardShown,
}: {
  /** Whether the mail list can show the inbox style card, which goes first. */
  inboxStyleCardShown: boolean;
}) {
  const { emailAccountId, provider } = useAccount();
  const { data: user, mutate: mutateUser } = useUser();
  const { setting, loading, error, toggleDraftReplies } = useDraftReplies();
  // Hides the card at once; the hint saved below keeps it hidden next visit.
  const [isClosed, setIsClosed] = useState(false);
  const [isTurningOn, setIsTurningOn] = useState(false);

  const hintId = getDraftRepliesHintId(emailAccountId);
  if (
    isClosed ||
    loading ||
    error ||
    setting !== "unset" ||
    !user ||
    user.dismissedHints.includes(hintId) ||
    (inboxStyleCardShown &&
      isInboxStyleCardPending({
        provider,
        emailAccountId,
        dismissedHints: user.dismissedHints,
      }))
  ) {
    return null;
  }

  function dismiss() {
    setIsClosed(true);
    dismissHintAction({ hintId }).then(() => mutateUser());
  }

  async function turnOn() {
    setIsTurningOn(true);
    try {
      await toggleDraftReplies(true);
    } catch (error) {
      // The card stays, so the user can try again or choose "Not now".
      toastError({
        title: "Couldn’t turn on suggested replies",
        description: error instanceof Error ? error.message : "Try again.",
      });
      return;
    } finally {
      setIsTurningOn(false);
    }
    dismiss();
  }

  return (
    <section
      aria-labelledby="draft-replies-card-title"
      className="mx-3 my-2 shrink-0 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <h2 id="draft-replies-card-title" className="font-medium text-sm">
        Cue can suggest replies for mail that needs one
      </h2>
      <p className="mt-0.5 text-muted-foreground text-xs">
        Cue sorts out the mail that needs a reply and suggests one in your tone.
        Suggestions stay in Cue until you edit them, and Cue never sends
        anything itself.
      </p>
      <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
        <Button
          size="xs-2"
          variant="ghost"
          disabled={isTurningOn}
          onClick={dismiss}
        >
          Not now
        </Button>
        <Button size="xs-2" loading={isTurningOn} onClick={turnOn}>
          Turn on
        </Button>
      </div>
    </section>
  );
}

function getDraftRepliesHintId(emailAccountId: string) {
  return `draft-replies:${emailAccountId}`;
}
