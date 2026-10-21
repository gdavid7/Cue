import {
  MAX_MAILBOX_COUNT_TARGETS,
  type MailPredicate,
} from "@inboxzero/mail-core/queries";
import { withoutHiddenDrafts } from "@/utils/mail-engine/threads-query";

export const MAX_MAILBOX_COUNT_LABELS = 100;

export type MailboxCountKind = "system" | "category" | "label" | "folder";

export type MailboxCountFolder = {
  id: string;
  displayName: string;
  childFolders?: MailboxCountFolder[];
  systemType?: string | null;
};

export type MailboxLabelCount = {
  id: string;
  name: string;
  kind: MailboxCountKind;
  total: number;
  unread: number;
};

export type MailboxCountTarget = {
  id: string;
  name: string;
  kind: MailboxCountKind;
  predicate: MailPredicate;
};

export function mailboxCountTargets(input: {
  labels: Array<{ id: string; name: string }>;
  folders: MailboxCountFolder[];
  /** Drafts a pending send stands in for, hidden from Drafts like in its list. */
  hiddenDraftMessageIds?: string[];
}): MailboxCountTarget[] {
  const targets: MailboxCountTarget[] = [
    {
      id: "INBOX",
      name: "Inbox",
      kind: "system",
      predicate: { kind: "role", role: "inbox" },
    },
    {
      id: "DRAFT",
      name: "Drafts",
      kind: "system",
      predicate: draftsCountPredicate(input.hiddenDraftMessageIds ?? []),
    },
  ];

  for (const label of input.labels.slice(0, MAX_MAILBOX_COUNT_LABELS)) {
    targets.push({
      id: label.id,
      name: label.name,
      kind: "label",
      predicate: { kind: "membership", membership: "label", id: label.id },
    });
  }

  for (const folder of userFolders(input.folders)) {
    targets.push({
      id: folder.id,
      name: folder.displayName,
      kind: "folder",
      predicate: { kind: "membership", membership: "folder", id: folder.id },
    });
  }

  return targets.slice(0, MAX_MAILBOX_COUNT_TARGETS);
}

/**
 * All inboxes' Drafts count: one target per account, each counted as that
 * account's own Drafts count, to be summed. A message id names a message only
 * within its own account, so each account hides only its own drafts.
 */
export function allInboxesDraftsCountTargets(
  accounts: Array<{ id: string; hiddenDraftMessageIds: string[] }>,
): Array<Pick<MailboxCountTarget, "id" | "predicate">> {
  return accounts.map((account) => ({
    id: account.id,
    predicate: {
      kind: "all",
      predicates: [
        { kind: "account", ids: [account.id] },
        draftsCountPredicate(account.hiddenDraftMessageIds),
      ],
    },
  }));
}

/** Drafts a pending send stands in for are hidden from Drafts like in its list. */
function draftsCountPredicate(hiddenDraftMessageIds: string[]): MailPredicate {
  return withoutHiddenDrafts(
    { kind: "role", role: "draft" },
    hiddenDraftMessageIds,
  );
}

function userFolders(
  folders: MailboxCountFolder[],
): Array<{ id: string; displayName: string }> {
  return folders.flatMap((folder) => [
    ...(folder.systemType
      ? []
      : [{ id: folder.id, displayName: folder.displayName }]),
    ...userFolders(folder.childFolders ?? []),
  ]);
}
