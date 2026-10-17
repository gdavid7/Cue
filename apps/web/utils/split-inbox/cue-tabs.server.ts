import { after } from "next/server";
import {
  ActionType,
  ExecutedRuleStatus,
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
 * tracking rules that are missing are added, whatever the style: "Needs reply"
 * takes every conversation status rule, since once the person replies the
 * status the AI picks only resolves the conversation when that status's rule
 * is on. The opt-in "Needs reply" and "Reading" tabs, and the reading rules
 * behind them, only come with `addTabs`.
 *
 * Only missing rules are created, with no actions: nothing is labelled,
 * archived, moved or drafted in the mailbox. Rules the account already has are
 * never changed, so one the person turned off stays off, and a rule of their
 * own that already uses a system rule's name is left alone.
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
  const configs = systemTypes.map((systemType) => ({
    systemType,
    ...getRuleConfig(systemType),
  }));
  const existingRules = await prisma.rule.findMany({
    where: {
      emailAccountId,
      OR: [
        { systemType: { in: systemTypes } },
        { name: { in: configs.map((config) => config.name) } },
      ],
    },
    select: {
      id: true,
      name: true,
      systemType: true,
      enabled: true,
      actions: { select: { id: true, type: true, label: true } },
    },
  });

  // Earlier versions created these rules with one label action each. Dropping
  // that action stops them labelling the mailbox; anything the person set up
  // themselves (other actions, a renamed label) is left as it is. Only the
  // tabs need it, so picking a style alone never touches the mailbox's labels.
  if (addTabs) await removeLegacyLabelActions(existingRules);

  const missing = configs.filter(
    (config) =>
      !existingRules.some(
        (rule) =>
          rule.systemType === config.systemType || rule.name === config.name,
      ),
  );
  // skipDuplicates covers a rule added since the read: it is skipped, not
  // replaced.
  const created = missing.length
    ? await prisma.rule.createManyAndReturn({
        data: missing.map((config) => ({
          emailAccountId,
          name: config.name,
          instructions: config.instructions,
          systemType: config.systemType,
          runOnThreads: config.runOnThreads,
          enabled: true,
        })),
        skipDuplicates: true,
        select: { id: true },
      })
    : [];

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

  // Rules only sort mail as it arrives, so Needs reply and the tabs would sit
  // empty until then. Sorting the latest inbox mail with just the new rules
  // fills them now, without re-running the person's other rules on old mail.
  // A mailbox Cue has never sorted also gets the reply tracking rules it was
  // created with, as long as they are on and have no actions, so the sort
  // changes nothing in the mailbox.
  const neverSorted = !(await prisma.executedRule.findFirst({
    where: { emailAccountId, status: { not: ExecutedRuleStatus.ERROR } },
    select: { id: true },
  }));
  const ruleIds = [
    ...(neverSorted
      ? existingRules
          .filter(
            (rule) =>
              isConversationStatusType(rule.systemType) &&
              rule.enabled &&
              !rule.actions.length,
          )
          .map((rule) => rule.id)
      : []),
    ...created.map((rule) => rule.id),
  ];
  if (ruleIds.length) {
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
        ruleIds,
        logger,
      });
    });
  }
}

async function removeLegacyLabelActions(
  rules: {
    systemType: SystemType | null;
    actions: { id: string; type: ActionType; label: string | null }[];
  }[],
) {
  const legacyLabelActionIds = rules.flatMap((rule) => {
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
  if (!legacyLabelActionIds.length) return;
  await prisma.action.deleteMany({
    where: { id: { in: legacyLabelActionIds } },
  });
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
