import { MailSplitFilterKind } from "@/generated/prisma/enums";
import { SafeError } from "@/utils/error";
import prisma from "@/utils/prisma";
import {
  getInboxStyleOptions,
  getInboxStyleSplits,
  orderSplitsForInboxStyle,
  type InboxStyle,
} from "@/utils/split-inbox/inbox-styles";
import { MAX_MAIL_SPLITS } from "@/utils/split-inbox/split-constants";
import {
  createMailSplit,
  reorderMailSplits,
} from "@/utils/split-inbox/splits.server";

/**
 * Adds the tabs of the inbox the person is used to next to the splits they
 * already have. Running it again reuses tabs that already show the same mail.
 */
export async function applyInboxStyle({
  emailAccountId,
  provider,
  style,
}: {
  emailAccountId: string;
  provider: string;
  style: InboxStyle;
}) {
  if (!getInboxStyleOptions(provider).includes(style)) {
    throw new SafeError("That inbox style isn't available for this account.");
  }

  const styleSplits = getInboxStyleSplits(style);
  if (!styleSplits.length) return;

  const existing = await getSplits(emailAccountId);
  const styleSplitIds: string[] = [];
  for (const draft of styleSplits) {
    const category = draft.filters[0]?.value;
    const match = existing.find(
      (split) =>
        split.name.toLowerCase() === draft.name.toLowerCase() ||
        (split.filters.length === 1 &&
          split.filters[0].kind === MailSplitFilterKind.CATEGORY &&
          split.filters[0].value === category),
    );
    if (match) {
      styleSplitIds.push(match.id);
      continue;
    }

    const result = await createMailSplit({
      emailAccountId,
      name: draft.name,
      matchAll: true,
      filters: draft.filters,
    });
    if (result?.status === "limit") {
      throw new SafeError(
        `You can only have ${MAX_MAIL_SPLITS} splits. Turn one off and try again.`,
      );
    }
    if (result?.status === "created") styleSplitIds.push(result.id);
  }

  await reorderMailSplits({
    emailAccountId,
    ids: orderSplitsForInboxStyle(
      await getSplits(emailAccountId),
      styleSplitIds,
    ),
  });
}

function getSplits(emailAccountId: string) {
  return prisma.mailSplit.findMany({
    where: { emailAccountId },
    orderBy: [{ order: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      name: true,
      filters: { select: { kind: true, value: true } },
    },
  });
}
