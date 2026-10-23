import {
  isThreadInInbox,
  isThreadOnlyIn,
} from "@/app/(app)/[emailAccountId]/mail/read-state";
import { isThreadStarred } from "@/app/(app)/[emailAccountId]/mail/star-state";
import { GmailLabel } from "@/utils/gmail/label";

/** A sidebar row conversations can be dropped on. */
export type SidebarDropTarget =
  | { kind: "inbox" | "archive" | "trash" | "spam" | "starred" }
  /** A Gmail label or Outlook category, which belongs to one account. */
  | { kind: "label"; accountId: string; labelId: string }
  /** An Outlook folder, which belongs to one account. */
  | OutlookFolderDrop;

type OutlookFolderDrop = {
  kind: "folder";
  accountId: string;
  folderId: string;
  name: string;
};

export type DraggedConversation = {
  key: string;
  threadId: string;
  accountId: string;
  messages: readonly { labelIds?: string[] | null }[];
};

export type SidebarDropAction =
  | {
      kind:
        | "archive"
        | "move_to_inbox"
        | "restore"
        | "not_spam"
        | "trash"
        | "spam"
        | "star";
    }
  | { kind: "label"; accountId: string; labelId: string }
  | OutlookFolderDrop;

/**
 * What dropping these conversations on a sidebar row does, as the toolbar or
 * the label picker would do it, or null where the drop would do nothing or
 * nothing sensible: the open view, mail already there, or a label or folder
 * the conversations' account doesn't have.
 */
export function resolveSidebarDrop({
  target,
  conversations,
  isCurrentView,
}: {
  target: SidebarDropTarget;
  conversations: readonly DraggedConversation[];
  isCurrentView: boolean;
}): SidebarDropAction | null {
  if (isCurrentView || !conversations.length) return null;
  const all = (test: (conversation: DraggedConversation) => boolean) =>
    conversations.every(test);
  const trashed = (conversation: DraggedConversation) =>
    isThreadOnlyIn(conversation.messages, GmailLabel.TRASH);
  const spam = (conversation: DraggedConversation) =>
    isThreadOnlyIn(conversation.messages, GmailLabel.SPAM);
  // Any trash or spam at all, as a mix that no single way out covers.
  const touchesTrashOrSpam = conversations.some((conversation) =>
    conversation.messages.some((message) =>
      message.labelIds?.some(
        (id) => id === GmailLabel.TRASH || id === GmailLabel.SPAM,
      ),
    ),
  );
  const inInbox = (conversation: DraggedConversation) =>
    isThreadInInbox(conversation.messages);

  const allFromAccount = (accountId: string) =>
    all((conversation) => conversation.accountId === accountId);

  switch (target.kind) {
    case "inbox":
      // The toolbar's ways back: Restore out of Trash, Not spam out of Spam.
      if (all(trashed)) return { kind: "restore" };
      if (all(spam)) return { kind: "not_spam" };
      if (touchesTrashOrSpam || all(inInbox)) return null;
      return { kind: "move_to_inbox" };
    case "archive":
      // Archiving from Trash or Spam would leave the mail there.
      if (touchesTrashOrSpam || !conversations.some(inInbox)) return null;
      return { kind: "archive" };
    case "trash":
      return all(trashed) ? null : { kind: "trash" };
    case "spam":
      return all(spam) ? null : { kind: "spam" };
    case "starred":
      return all((conversation) => isThreadStarred(conversation.messages))
        ? null
        : { kind: "star" };
    case "label": {
      // A label id names one account's label; other accounts don't have it.
      if (!allFromAccount(target.accountId)) return null;
      const labelled = (conversation: DraggedConversation) =>
        conversation.messages.some((message) =>
          message.labelIds?.includes(target.labelId),
        );
      if (all(labelled)) return null;
      return {
        kind: "label",
        accountId: target.accountId,
        labelId: target.labelId,
      };
    }
    case "folder":
      // A folder id names one account's folder. Moving keeps trash or spam
      // marked as such, so that mail has to come out of there first.
      if (!allFromAccount(target.accountId) || touchesTrashOrSpam) return null;
      return { ...target };
  }
}
