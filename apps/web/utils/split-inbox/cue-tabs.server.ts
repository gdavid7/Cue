import { after } from "next/server";
import {
  ActionType,
  MailSplitFilterKind,
  SystemType,
} from "@/generated/prisma/enums";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { ONBOARDING_PROCESS_EMAILS_COUNT } from "@/utils/config";
import { createEmailProvider } from "@/utils/email/provider";
import { SafeError } from "@/utils/error";
import { resolveLabelNameAndId } from "@/utils/label/resolve-label";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { CONVERSATION_STATUS_TYPES } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import { upsertSystemRule } from "@/utils/rule/rule";
import { MAX_MAIL_SPLITS } from "@/utils/split-inbox/split-constants";
import { createMailSplit } from "@/utils/split-inbox/splits.server";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

const READING_SYSTEM_TYPES = [SystemType.NEWSLETTER, SystemType.MARKETING];

/**
 * "Needs reply" shows the To Reply label, but it takes every conversation
 * status rule to keep that label honest: once the person replies, reply
 * tracking relabels the thread with the status the AI picks, and it only does
 * so when that status's rule is on.
 */
const CUE_TAB_SYSTEM_TYPES = [
  ...CONVERSATION_STATUS_TYPES,
  ...READING_SYSTEM_TYPES,
];

/**
 * The opt-in "Needs reply" and "Reading" tabs. Creates only the label rules
 * those two tabs read, each of which labels mail and leaves it where it is: no
 * archiving, no moving, no drafts. Rules the account already has are kept as
 * they are.
 */
export async function addCueTabs({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) {
  const existingRules = await prisma.rule.findMany({
    where: { emailAccountId, systemType: { in: CUE_TAB_SYSTEM_TYPES } },
    select: {
      systemType: true,
      actions: { select: { type: true, labelId: true } },
    },
  });
  const labelIds = new Map<SystemType, string>();
  for (const rule of existingRules) {
    const labelId = rule.actions.find(
      (action) => action.type === ActionType.LABEL && action.labelId,
    )?.labelId;
    if (rule.systemType && labelId) labelIds.set(rule.systemType, labelId);
  }

  const missing = CUE_TAB_SYSTEM_TYPES.filter(
    (systemType) =>
      !existingRules.some((rule) => rule.systemType === systemType),
  );
  if (missing.length) {
    const emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
    for (const systemType of missing) {
      const config = getRuleConfig(systemType);
      const { label, labelId } = await resolveLabelNameAndId({
        emailProvider,
        label: config.label,
        labelId: null,
      });
      await upsertSystemRule({
        name: config.name,
        instructions: config.instructions,
        actions: [{ type: ActionType.LABEL, label, labelId }],
        emailAccountId,
        systemType,
        runOnThreads: config.runOnThreads,
        enabled: true,
        logger,
      });
      if (labelId) labelIds.set(systemType, labelId);
    }
  }

  const needsReplyLabelId = labelIds.get(SystemType.TO_REPLY);
  const readingLabelIds = READING_SYSTEM_TYPES.flatMap((systemType) => {
    const labelId = labelIds.get(systemType);
    return labelId ? [labelId] : [];
  });
  const splits = [
    ...(needsReplyLabelId
      ? [{ name: "Needs reply", matchAll: true, labelIds: [needsReplyLabelId] }]
      : []),
    ...(readingLabelIds.length
      ? [{ name: "Reading", matchAll: false, labelIds: readingLabelIds }]
      : []),
  ];
  for (const split of splits) {
    const result = await createMailSplit({
      emailAccountId,
      name: split.name,
      matchAll: split.matchAll,
      filters: split.labelIds.map((value) => ({
        kind: MailSplitFilterKind.LABEL,
        value,
      })),
    });
    if (result?.status === "limit") {
      throw new SafeError(
        `You can only have ${MAX_MAIL_SPLITS} splits. Turn one off and try again.`,
      );
    }
  }

  // New rules only label mail as it arrives, so the tabs would sit empty until
  // then. Labeling the latest inbox mail fills them now.
  if (missing.length) {
    after(async () => {
      const emailAccount = await getEmailAccountForRuleExecution({
        emailAccountId,
      });
      if (!emailAccount) return;
      await bulkProcessInboxEmails({
        emailAccount,
        provider,
        maxEmails: ONBOARDING_PROCESS_EMAILS_COUNT,
        skipArchive: true,
        logger,
      });
    });
  }
}
