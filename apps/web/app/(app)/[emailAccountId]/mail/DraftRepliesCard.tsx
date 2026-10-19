"use client";

import { useState } from "react";
import { useDraftReplies } from "@/app/(app)/[emailAccountId]/assistant/settings/DraftReplies";
import { toastError } from "@/components/Toast";
import { Button } from "@/components/ui/button";
import { useUser } from "@/hooks/useUser";
import { useAccount } from "@/providers/EmailAccountProvider";
import { dismissHintAction } from "@/utils/actions/hints";
import {
  getInboxStyleHintId,
  getInboxStyleOptions,
} from "@/utils/split-inbox/inbox-styles";

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
  // Waits for the inbox style card, so a mailbox never shows both at once.
  const inboxStylePending =
    inboxStyleCardShown &&
    getInboxStyleOptions(provider).length > 1 &&
    !user?.dismissedHints.includes(getInboxStyleHintId(emailAccountId));
  if (
    isClosed ||
    loading ||
    error ||
    setting !== "unset" ||
    !user ||
    user.dismissedHints.includes(hintId) ||
    inboxStylePending
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
      dismiss();
    } catch {
      toastError({
        description: "Couldn’t turn on draft replies. Try again.",
      });
    } finally {
      setIsTurningOn(false);
    }
  }

  return (
    <section
      aria-labelledby="draft-replies-card-title"
      className="mx-3 my-2 shrink-0 rounded-xl border border-border bg-card p-3 shadow-sm"
    >
      <h2 id="draft-replies-card-title" className="font-medium text-sm">
        Cue can draft replies for mail that needs one
      </h2>
      <p className="mt-0.5 text-muted-foreground text-xs">
        Drafts wait in the conversation for you to edit and send. Cue never
        sends them. You can change this anytime in Settings.
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
