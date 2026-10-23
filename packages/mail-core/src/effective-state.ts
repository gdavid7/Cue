import type { MetadataChange } from "./commands";
import { PROVIDER_CAPABILITIES, type Provider } from "./identities";
import type { MessageMetadata } from "./messages";
import type { MailboxRole } from "./messages";

export type ConfirmedMessage = MessageMetadata & {
  accountId: string;
  messageId: string;
  conversationId: string;
  version: string | null;
  deleted: boolean;
};

export type PendingEffect = {
  operationId: string;
  change: MetadataChange;
  targets: Array<{ accountId: string; messageId: string }>;
};

export function applyMetadataChange(
  metadata: MessageMetadata,
  change: MetadataChange,
): MessageMetadata {
  switch (change.kind) {
    case "archive":
      return {
        ...withRoles(metadata, withoutRole(metadata.roles, "inbox")),
        snoozedUntilMs: null,
      };
    case "unarchive":
      return {
        ...withRoles(
          metadata,
          uniqueRoles([...withoutRole(metadata.roles, "trash"), "inbox"]),
        ),
        snoozedUntilMs: null,
      };
    case "set_read":
      return { ...metadata, read: change.read };
    case "set_starred":
      return { ...metadata, starred: change.starred };
    // Trash and spam end a snooze, as archive and move to inbox do.
    case "trash":
      return {
        ...withRoles(metadata, uniqueRoles(["trash"])),
        snoozedUntilMs: null,
      };
    case "restore_from_trash":
      return withRoles(
        metadata,
        uniqueRoles([...withoutRole(metadata.roles, "trash"), "inbox"]),
      );
    case "set_spam":
      return change.spam
        ? {
            ...withRoles(metadata, uniqueRoles(["spam"])),
            snoozedUntilMs: null,
          }
        : withRoles(
            metadata,
            uniqueRoles([...withoutRole(metadata.roles, "spam"), "inbox"]),
          );
    case "move":
      return {
        ...withRoles(metadata, withoutRole(metadata.roles, "inbox")),
        folderId: change.folderId,
      };
    case "set_membership":
      if (change.membership === "label") {
        return {
          ...metadata,
          labelIds: setMembership(metadata.labelIds, change.id, change.present),
        };
      }
      return {
        ...metadata,
        categoryIds: setMembership(
          metadata.categoryIds,
          change.id,
          change.present,
        ),
      };
    case "snooze":
      return {
        ...withRoles(metadata, withoutRole(metadata.roles, "inbox")),
        snoozedUntilMs: change.untilMs,
      };
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

/**
 * The messages of one conversation that a conversation command changes. On a
 * folder-based provider, a change that moves mail between folders leaves the
 * user's own Sent and Drafts copies where they are, as the provider's own
 * conversation actions do, unless nothing else is left to move. Moving mail
 * away doesn't count what is already in Trash or Spam, so deleting a
 * conversation that is only your reply and old deleted mail still deletes the
 * reply. A message with no stored copy (`roles: null`) can't be told apart
 * from the user's own mail, so it is left out there. A `wholeConversation`
 * command, made in Sent or Drafts, reaches every message.
 */
export function conversationTargets<T extends { roles: MailboxRole[] | null }>(
  messages: T[],
  change: MetadataChange,
  provider: Provider | null,
  wholeConversation: boolean,
): T[] {
  const direction = folderMove(change);
  if (
    wholeConversation ||
    !provider ||
    !PROVIDER_CAPABILITIES[provider].folderBasedRoles
  ) {
    return messages;
  }
  if (!direction) return messages;
  const known = messages.filter(
    (message): message is T & { roles: MailboxRole[] } =>
      message.roles !== null,
  );
  const others = known.filter(({ roles }) => !isOwnMail(roles));
  const moving =
    direction === "away"
      ? others.filter(
          ({ roles }) => !roles.includes("trash") && !roles.includes("spam"),
        )
      : others;
  return moving.length > 0 ? others : known;
}

/** Whether `change` on a conversation leaves the user's Sent and Drafts copies alone. */
export function leavesOwnMailInPlace(
  change: MetadataChange,
  provider: Provider,
): boolean {
  return (
    PROVIDER_CAPABILITIES[provider].folderBasedRoles &&
    folderMove(change) !== null
  );
}

/** Whether `change` moves mail between folders on a folder-based provider. */
export function movesBetweenFolders(change: MetadataChange): boolean {
  return folderMove(change) !== null;
}

export function deriveEffectiveMessage(
  confirmed: ConfirmedMessage,
  pending: PendingEffect[],
): ConfirmedMessage & { pendingOperationIds: string[] } {
  if (confirmed.deleted) {
    return { ...confirmed, pendingOperationIds: [] };
  }
  let metadata: MessageMetadata = confirmed;
  const pendingOperationIds: string[] = [];
  for (const effect of pending) {
    if (
      !effect.targets.some(
        (target) =>
          target.accountId === confirmed.accountId &&
          target.messageId === confirmed.messageId,
      )
    ) {
      continue;
    }
    metadata = applyMetadataChange(metadata, effect.change);
    pendingOperationIds.push(effect.operationId);
  }
  return {
    ...confirmed,
    ...metadata,
    pendingOperationIds,
  };
}

export function applyMetadataPatch(
  current: MessageMetadata,
  patch: Partial<MessageMetadata>,
): MessageMetadata {
  return {
    subject: patch.subject ?? current.subject,
    preview: patch.preview ?? current.preview,
    externalUrl:
      patch.externalUrl === undefined ? current.externalUrl : patch.externalUrl,
    from: patch.from ?? current.from,
    to: patch.to ?? current.to,
    cc: patch.cc ?? current.cc,
    bcc: patch.bcc ?? current.bcc,
    receivedAtMs: patch.receivedAtMs ?? current.receivedAtMs,
    read: patch.read ?? current.read,
    starred: patch.starred ?? current.starred,
    folderId: patch.folderId === undefined ? current.folderId : patch.folderId,
    inboxSection:
      patch.inboxSection === undefined
        ? current.inboxSection
        : patch.inboxSection,
    labelIds: patch.labelIds ?? current.labelIds,
    categoryIds: patch.categoryIds ?? current.categoryIds,
    roles: patch.roles ?? current.roles,
    hasAttachments: patch.hasAttachments ?? current.hasAttachments,
    snoozedUntilMs:
      patch.snoozedUntilMs === undefined
        ? current.snoozedUntilMs
        : patch.snoozedUntilMs,
    // A message's Message-ID never changes, so a patch without it keeps it.
    internetMessageId: patch.internetMessageId ?? current.internetMessageId,
  };
}

function withRoles(
  metadata: MessageMetadata,
  roles: MailboxRole[],
): MessageMetadata {
  return { ...metadata, roles };
}

function withoutRole(roles: MailboxRole[], role: MailboxRole): MailboxRole[] {
  return roles.filter((candidate) => candidate !== role);
}

function uniqueRoles(roles: MailboxRole[]): MailboxRole[] {
  return [...new Set(roles)];
}

function setMembership(ids: string[], id: string, present: boolean): string[] {
  if (present) return [...new Set([...ids, id])];
  return ids.filter((candidate) => candidate !== id);
}

// Spam and snooze also move mail, but the server still applies them to the
// whole Outlook conversation, so the local state follows it until the server
// acts per message.
function folderMove(change: MetadataChange): "away" | "back" | null {
  switch (change.kind) {
    case "archive":
    case "trash":
    case "move":
      return "away";
    case "unarchive":
    case "restore_from_trash":
      return "back";
    case "set_spam":
    case "snooze":
    case "set_read":
    case "set_starred":
    case "set_membership":
      return null;
    default: {
      const exhaustive: never = change;
      return exhaustive;
    }
  }
}

function isOwnMail(roles: MailboxRole[]) {
  return roles.includes("sent") || roles.includes("draft");
}
