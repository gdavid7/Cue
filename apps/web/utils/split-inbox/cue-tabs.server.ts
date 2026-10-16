import { after } from "next/server";
import {
  ActionType,
  MailSplitFilterKind,
  SystemType,
} from "@/generated/prisma/enums";
import { normalizeLabelName } from "@/utils/label/normalize-label-name";
import { bulkProcessInboxEmails } from "@/utils/ai/choose-rule/bulk-process-emails";
import { ONBOARDING_PROCESS_EMAILS_COUNT } from "@/utils/config";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import {
  CONVERSATION_STATUS_TYPES,
  isConversationStatusType,
} from "@/utils/reply-tracker/conversation-status-config";
import { getRuleConfig } from "@/utils/rule/consts";
import { upsertSystemRule } from "@/utils/rule/rule";
import { MAX_MAIL_SPLITS } from "@/utils/split-inbox/split-constants";
import {
  createMailSplit,
  updateMailSplit,
} from "@/utils/split-inbox/splits.server";
import { getEmailAccountForRuleExecution } from "@/utils/user/get";

const READING_SYSTEM_TYPES = [SystemType.NEWSLETTER, SystemType.MARKETING];

const CUE_TABS = [
  {
    name: "Needs reply",
    matchAll: true,
    values: [SystemType.TO_REPLY],
  },
  {
    name: "Reading",
    matchAll: false,
    values: READING_SYSTEM_TYPES,
  },
];

/**
 * Sets up Cue's own sorting when the person picks an inbox style. Reply
 * tracking is always turned on, whatever the style: "Needs reply" takes every
 * conversation status rule, since once the person replies the status the AI
 * picks only resolves the conversation when that status's rule is on. The
 * opt-in "Needs reply" and "Reading" tabs, and the reading rules behind them,
 * only come with `addTabs`.
 *
 * Both read what Cue's rules decided from Cue's own database, so the rules are
 * added with no actions: nothing is labelled, archived, moved or drafted in the
 * mailbox. Rules the account already has are kept, minus the label action Cue
 * added.
 */
export async function setUpCueSorting({
  emailAccountId,
  provider,
  addTabs,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  addTabs: boolean;
  logger: Logger;
}) {
  const systemTypes = addTabs
    ? [...CONVERSATION_STATUS_TYPES, ...READING_SYSTEM_TYPES]
    : CONVERSATION_STATUS_TYPES;
  const existingRules = await prisma.rule.findMany({
    where: { emailAccountId, systemType: { in: systemTypes } },
    select: {
      id: true,
      systemType: true,
      enabled: true,
      actions: { select: { id: true, type: true, label: true } },
    },
  });

  // Earlier versions created these rules with one label action each. Dropping
  // that action stops them labelling the mailbox; anything the person set up
  // themselves (other actions, a renamed label) is left as it is.
  const legacyLabelActionIds = existingRules.flatMap((rule) => {
    const [action, ...rest] = rule.actions;
    const isLegacyLabel =
      rule.systemType &&
      action &&
      !rest.length &&
      action.type === ActionType.LABEL &&
      normalizeLabelName(action.label ?? "") ===
        normalizeLabelName(getRuleConfig(rule.systemType).label);
    return isLegacyLabel ? [action.id] : [];
  });
  if (legacyLabelActionIds.length) {
    await prisma.action.deleteMany({
      where: { id: { in: legacyLabelActionIds } },
    });
  }

  const disabledReplyTrackingIds = existingRules
    .filter(
      (rule) => isConversationStatusType(rule.systemType) && !rule.enabled,
    )
    .map((rule) => rule.id);
  if (disabledReplyTrackingIds.length) {
    await prisma.rule.updateMany({
      where: { id: { in: disabledReplyTrackingIds } },
      data: { enabled: true },
    });
  }

  const missing = systemTypes.filter(
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

  if (addTabs) {
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
  }

  // Rules only sort mail as it arrives, so Needs reply would sit empty until
  // then. Sorting the latest inbox mail fills it now.
  if (missing.length || disabledReplyTrackingIds.length) {
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
