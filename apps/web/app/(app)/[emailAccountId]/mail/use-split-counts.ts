"use client";

import { useEffect, useMemo, useState } from "react";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { labelNamesToAccountScopedPredicate } from "@/app/(app)/[emailAccountId]/mail/use-combined-mail-threads";
import { useCueMembership } from "@/hooks/useCueMembership";
import type { EmailLabels } from "@/providers/email-label-types";
import { splitUsesCue } from "@/utils/split-inbox/cue-filter";
import { splitCountTargets } from "@/utils/split-inbox/split-counts";
import type {
  MailSplit,
  PortableLabelSplit,
} from "@/utils/split-inbox/split-query";

const EMPTY_COUNTS = new Map<string, number>();
const EMPTY_SPLIT_COUNTS = {
  countsById: EMPTY_COUNTS,
  matchingById: EMPTY_COUNTS,
};

export function useSplitCounts({
  accountIds,
  splits,
  enabled,
  portableLabelSplits,
  labelsByAccount,
}: {
  accountIds: string[];
  splits: MailSplit[];
  enabled: boolean;
  portableLabelSplits?: PortableLabelSplit[];
  labelsByAccount?: Record<string, EmailLabels>;
}) {
  const client = useOptionalMailClient();
  const accountKey = accountIds.join("\0");
  const stableAccountIds = useMemo(
    () => (accountKey ? accountKey.split("\0") : []),
    [accountKey],
  );
  const overrides = useMemo(
    () =>
      portableLabelSplits
        ? portableSplitCountOverrides({
            portableLabelSplits,
            accountIds: stableAccountIds,
            labelsByAccount,
          })
        : undefined,
    [labelsByAccount, portableLabelSplits, stableAccountIds],
  );
  // Cue's sorting is per account; views spanning accounts don't show its splits.
  const { membership: cueMembership } = useCueMembership(
    enabled && stableAccountIds.length === 1 && splits.some(splitUsesCue),
  );
  const targets = useMemo(
    () => splitCountTargets({ splits, overrides, cueMembership }),
    [cueMembership, overrides, splits],
  );
  // Unread drives the tab badges; matching is the full count, which the
  // first-run tour reads to say how many emails need a reply.
  const [splitCounts, setSplitCounts] = useState(EMPTY_SPLIT_COUNTS);

  useEffect(() => {
    if (
      !client ||
      !enabled ||
      stableAccountIds.length === 0 ||
      targets.length === 0
    ) {
      setSplitCounts((current) =>
        current.countsById.size === 0 && current.matchingById.size === 0
          ? current
          : EMPTY_SPLIT_COUNTS,
      );
      return;
    }

    const handle = client.observeMailboxCounts({
      accountIds: stableAccountIds,
      targets,
    });
    const apply = () => {
      const unread = new Map<string, number>();
      const matching = new Map<string, number>();
      for (const count of handle.getSnapshot().data?.counts ?? []) {
        unread.set(count.id, count.unreadConversations);
        matching.set(count.id, count.matchingConversations);
      }
      setSplitCounts((current) =>
        sameCounts(current.countsById, unread) &&
        sameCounts(current.matchingById, matching)
          ? current
          : { countsById: unread, matchingById: matching },
      );
    };
    const unsubscribe = handle.subscribe(apply);
    apply();
    return () => {
      unsubscribe();
      handle.close();
    };
  }, [client, enabled, stableAccountIds, targets]);

  return splitCounts;
}

function portableSplitCountOverrides({
  portableLabelSplits,
  accountIds,
  labelsByAccount,
}: {
  portableLabelSplits: PortableLabelSplit[];
  accountIds: string[];
  labelsByAccount?: Record<string, EmailLabels>;
}) {
  const labelsReady = Object.keys(labelsByAccount ?? {}).length > 0;
  const overrides = new Map<string, MailPredicate | null>();
  for (const split of portableLabelSplits) {
    overrides.set(
      split.id,
      labelsReady && labelsByAccount
        ? labelNamesToAccountScopedPredicate({
            accountIds,
            labelsByAccount,
            labelNames: split.labelNames,
          })
        : null,
    );
  }
  return overrides;
}

function sameCounts(left: Map<string, number>, right: Map<string, number>) {
  if (left.size !== right.size) return false;
  for (const [id, count] of right) {
    if (left.get(id) !== count) return false;
  }
  return true;
}
