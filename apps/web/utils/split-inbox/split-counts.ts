import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { threadsQueryToPredicate } from "@/utils/mail-engine/threads-query";
import {
  type CueMembership,
  splitUsesCue,
} from "@/utils/split-inbox/cue-filter";
import {
  OTHER_SPLIT_ID,
  mailSplitToThreadsQuery,
  otherMailSplitQuery,
  type MailSplit,
} from "@/utils/split-inbox/split-query";

/**
 * Counts use the same predicate as the thread list. A client-side count of the
 * loaded page would under-report every split that has more mail than one page.
 */
export function splitCountTargets({
  splits,
  now = new Date(),
  overrides,
  cueMembership,
}: {
  splits: MailSplit[];
  now?: Date;
  /** `null` means the split's predicate is not ready, so it is left uncounted. */
  overrides?: ReadonlyMap<string, MailPredicate | null>;
  /** Until it loads, splits that read Cue's own sorting are left uncounted. */
  cueMembership?: CueMembership;
}): Array<{ id: string; predicate: MailPredicate }> {
  const targets: Array<{ id: string; predicate: MailPredicate }> = [];

  for (const split of splits) {
    if (overrides?.has(split.id)) {
      const override = overrides.get(split.id);
      if (override) targets.push({ id: split.id, predicate: override });
      continue;
    }

    const readsCue =
      split.id === OTHER_SPLIT_ID
        ? splits.some(splitUsesCue)
        : splitUsesCue(split);
    if (readsCue && !cueMembership) continue;

    try {
      targets.push({
        id: split.id,
        predicate: predicateForSplit(split, splits, now, cueMembership),
      });
    } catch {
      // The list query throws for a split that is missing a required value.
      // Skip it here so one incomplete split does not blank every other count.
    }
  }

  return targets;
}

function predicateForSplit(
  split: MailSplit,
  splits: MailSplit[],
  now: Date,
  cueMembership: CueMembership | undefined,
): MailPredicate {
  const query =
    split.id === OTHER_SPLIT_ID
      ? otherMailSplitQuery(splits)
      : mailSplitToThreadsQuery(split, now);
  return threadsQueryToPredicate(query, cueMembership);
}
