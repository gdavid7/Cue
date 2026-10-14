import { SystemType } from "@/generated/prisma/enums";
import { isGoogleProvider } from "@/utils/email/provider-types";
import type { EmailProvider } from "@/utils/email/types";
import { normalizeLabelName } from "@/utils/label/normalize-label-name";
import { getRuleConfig } from "@/utils/rule/consts";

/**
 * Rules whose label Cue used to apply to sort mail, before its tabs read Cue's
 * own database. Those labels are left over in the mailbox.
 */
export const CUE_LABEL_SYSTEM_TYPES = [
  SystemType.TO_REPLY,
  SystemType.AWAITING_REPLY,
  SystemType.FYI,
  SystemType.ACTIONED,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
];

const CUE_LABEL_NAMES = new Set(
  CUE_LABEL_SYSTEM_TYPES.map((systemType) =>
    normalizeLabelName(getRuleConfig(systemType).label),
  ),
);

/** Stored with the user's other dismissed hints, once per mailbox. */
export function getCueLabelsHintId(emailAccountId: string) {
  return `cue-labels:${emailAccountId}`;
}

/**
 * Labels named like the ones Cue created. A person may have made one of these
 * themselves before Cue, so callers let them choose rather than assume.
 */
export function findCueDefaultLabels<T extends { name: string }>(labels: T[]) {
  return labels.filter((label) =>
    CUE_LABEL_NAMES.has(normalizeLabelName(label.name)),
  );
}

/**
 * Outlook categories are skipped: Outlook can't say how many emails carry one,
 * so the person couldn't tell which ones are worth keeping.
 */
export async function getCueDefaultLabels(emailProvider: EmailProvider) {
  if (!isGoogleProvider(emailProvider.name)) return [];

  const labels = findCueDefaultLabels(
    await emailProvider.getLabels({ includeHidden: true }),
  );

  return Promise.all(
    labels.map(async (label) => {
      const details = await emailProvider.getLabelById(label.id);
      return {
        id: label.id,
        name: label.name,
        messagesTotal: details?.messagesTotal ?? null,
      };
    }),
  );
}
