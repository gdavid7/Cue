import { useCallback, useEffect, useMemo, useState } from "react";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import {
  useAllAccountsHiddenDraftMessageIds,
  useHiddenDraftMessageIds,
} from "@/hooks/useHiddenDraftMessageIds";
import {
  allInboxesDraftsCountTargets,
  mailboxCountTargets,
  type MailboxCountFolder,
  type MailboxLabelCount,
} from "@/utils/mail-engine/label-count-targets";

const NO_LABELS: Array<{ id: string; name: string }> = [];
const NO_FOLDERS: MailboxCountFolder[] = [];
const NO_COUNTS = new Map<string, MailboxLabelCount>();

/**
 * Unread/total counts per label or folder, derived from the same effective
 * mailbox queries as the lists. The sidebar renders without counts and fills in.
 */
export function useLabelCounts({
  emailAccountId,
  labels,
  folders,
}: {
  emailAccountId: string;
  labels: Array<{ id: string; name: string }>;
  folders: MailboxCountFolder[];
}) {
  const client = useOptionalMailClient();
  const resolvedLabels = labels.length > 0 ? labels : NO_LABELS;
  const resolvedFolders = folders.length > 0 ? folders : NO_FOLDERS;
  const hiddenDraftMessageIds = useHiddenDraftMessageIds(emailAccountId);
  const targets = useMemo(
    () =>
      mailboxCountTargets({
        labels: resolvedLabels,
        folders: resolvedFolders,
        hiddenDraftMessageIds,
      }),
    [resolvedFolders, resolvedLabels, hiddenDraftMessageIds],
  );
  const [countsById, setCountsById] = useState(
    new Map<string, MailboxLabelCount>(),
  );

  useEffect(() => {
    if (!client) {
      setCountsById(new Map());
      return;
    }
    const handle = client.observeMailboxCounts({
      accountIds: [emailAccountId],
      targets: targets.map(({ id, predicate }) => ({ id, predicate })),
    });
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    const apply = () => {
      const next = new Map<string, MailboxLabelCount>();
      for (const count of handle.getSnapshot().data?.counts ?? []) {
        const target = targetsById.get(count.id);
        if (!target) continue;
        next.set(target.id, {
          id: target.id,
          name: target.name,
          kind: target.kind,
          total: count.matchingConversations,
          unread: count.unreadConversations,
        });
      }
      setCountsById((current) => (sameCounts(current, next) ? current : next));
    };
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
    };
  }, [client, emailAccountId, targets]);

  const mutate = useCallback(async () => {
    await client?.requestSync([emailAccountId]);
  }, [client, emailAccountId]);

  return { countsById, mutate };
}

/**
 * The counts All inboxes shows: Drafts, the sum of each included account's own
 * Drafts count. No accounts reads nothing.
 */
export function useAllInboxesLabelCounts(
  accounts: { id: string }[] | undefined,
) {
  const client = useOptionalMailClient();
  const hiddenDrafts = useAllAccountsHiddenDraftMessageIds(accounts);
  const accountKey = accounts?.map((account) => account.id).join("\n");
  const targets = useMemo(() => {
    if (!accountKey) return [];
    return allInboxesDraftsCountTargets(
      accountKey.split("\n").map((id) => ({
        id,
        hiddenDraftMessageIds:
          hiddenDrafts.find((entry) => entry.emailAccountId === id)
            ?.messageIds ?? [],
      })),
    );
  }, [accountKey, hiddenDrafts]);
  const [drafts, setDrafts] = useState(0);

  useEffect(() => {
    if (!client || !targets.length) {
      setDrafts(0);
      return;
    }
    const handle = client.observeMailboxCounts({
      accountIds: targets.map((target) => target.id),
      targets,
    });
    const apply = () =>
      setDrafts(
        (handle.getSnapshot().data?.counts ?? []).reduce(
          (sum, count) => sum + count.matchingConversations,
          0,
        ),
      );
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
    };
  }, [client, targets]);

  return useMemo(
    () =>
      drafts
        ? new Map<string, MailboxLabelCount>([
            [
              "DRAFT",
              {
                id: "DRAFT",
                name: "Drafts",
                kind: "system",
                total: drafts,
                unread: 0,
              },
            ],
          ])
        : NO_COUNTS,
    [drafts],
  );
}

function sameCounts(
  left: Map<string, MailboxLabelCount>,
  right: Map<string, MailboxLabelCount>,
) {
  if (left.size !== right.size) return false;
  for (const [id, count] of right) {
    const previous = left.get(id);
    if (
      !previous ||
      previous.total !== count.total ||
      previous.unread !== count.unread ||
      previous.name !== count.name
    ) {
      return false;
    }
  }
  return true;
}
