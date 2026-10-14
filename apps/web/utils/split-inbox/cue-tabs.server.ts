import { after } from "next/server";
import { MailSplitFilterKind, SystemType } from "@/generated/prisma/enums";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { ONBOARDING_PROCESS_EMAILS_COUNT } from "@/utils/config";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { CONVERSATION_STATUS_TYPES } from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import { upsertSystemRule } from "@/utils/rule/rule";
import { MAX_MAIL_SPLITS } from "@/utils/split-inbox/split-constants";
import {
  createMailSplit,
  updateMailSplit,
} from "@/utils/split-inbox/splits.server";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

/**
 * "Needs reply" reads reply tracking, which takes every conversation status
 * rule: once the person replies, the status the AI picks only resolves the
 * conversation when that status's rule is on.
 */
const CUE_TAB_SYSTEM_TYPES = [
  ...CONVERSATION_STATUS_TYPES,
  SystemType.NEWSLETTER,
  SystemType.MARKETING,
];

const CUE_TABS = [
  {
    name: "Needs reply",
    matchAll: true,
    values: [SystemType.TO_REPLY],
  },
  {
    name: "Reading",
    matchAll: false,
    values: [SystemType.NEWSLETTER, SystemType.MARKETING],
  },
];

/**
 * The opt-in "Needs reply" and "Reading" tabs. They read what Cue's rules
 * decided from Cue's own database, so the rules they need are added with no
 * actions: nothing is labelled, archived, moved or drafted in the mailbox.
 * Rules the account already has are kept as they are.
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
    select: { systemType: true },
  });
  const missing = CUE_TAB_SYSTEM_TYPES.filter(
    (systemType) =>
      !existingRules.some((rule) => rule.systemType === systemType),
  );
  for (const systemType of missing) {
    const config = getRuleConfig(systemType);
    await upsertSystemRule({
      name: config.name,
      instructions: config.instructions,
      actions: [],
      emailAccountId,
      systemType,
      runOnThreads: config.runOnThreads,
      enabled: true,
      logger,
    });
  }

  for (const tab of CUE_TABS) {
    const split = {
      emailAccountId,
      name: tab.name,
      matchAll: tab.matchAll,
      filters: tab.values.map((value) => ({
        kind: MailSplitFilterKind.CUE,
        value,
      })),
    };
    const result = await createMailSplit(split);
    if (result?.status === "limit") {
      throw new SafeError(
        `You can only have ${MAX_MAIL_SPLITS} splits. Turn one off and try again.`,
      );
    }
    if (result?.status === "duplicate") {
      await repointLabelTab(split);
    }
  }

  // New rules only sort mail as it arrives, so the tabs would sit empty until
  // then. Sorting the latest inbox mail fills them now.
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

/**
 * Earlier versions backed these tabs with mailbox labels Cue created. A tab of
 * the same name that still only reads labels is that tab, so it moves to Cue's
 * own sorting; one the person built themselves is left alone.
 */
async function repointLabelTab(split: {
  emailAccountId: string;
  name: string;
  matchAll: boolean;
  filters: { kind: MailSplitFilterKind; value: string }[];
}) {
  const existing = await prisma.mailSplit.findFirst({
    where: { emailAccountId: split.emailAccountId, name: split.name },
    select: { id: true, filters: { select: { kind: true } } },
  });
  const isLabelTab =
    !!existing?.filters.length &&
    existing.filters.every(
      (filter) => filter.kind === MailSplitFilterKind.LABEL,
    );
  if (!existing || !isLabelTab) return;
  await updateMailSplit({ ...split, id: existing.id });
}
