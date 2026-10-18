// A new message can show up in the list a little before its date is final, and
// clocks differ; this keeps genuinely fresh mail while dropping sync backfill.
const FRESH_MAIL_GRACE_MS = 2 * 60 * 1000;

export type TrackedConversation = {
  /** Newest message id, so a reply in the same thread notifies again. */
  id: string;
  accountId: string;
  threadId: string;
  from: string;
  subject: string;
  latestMessageAtMs: number;
};

/**
 * Finds mail that arrived since the tab started watching. The first snapshot
 * only seeds what is already there, and anything dated before the tab started
 * is a sync backfill rather than new mail.
 */
export function createNewMailTracker({ startedAtMs }: { startedAtMs: number }) {
  const seen = new Set<string>();
  let seeded = false;

  return {
    take(conversations: TrackedConversation[]): TrackedConversation[] {
      const fresh = conversations.filter(
        (conversation) =>
          !seen.has(conversation.id) &&
          conversation.latestMessageAtMs >= startedAtMs - FRESH_MAIL_GRACE_MS,
      );
      for (const conversation of conversations) seen.add(conversation.id);
      if (!seeded) {
        seeded = true;
        return [];
      }
      return fresh;
    },
  };
}

export function senderDisplayName(from: string) {
  const match = from.match(/^\s*"?([^"<]*?)"?\s*<([^>]*)>\s*$/);
  if (!match) return from.trim();
  return match[1].trim() || match[2].trim();
}
