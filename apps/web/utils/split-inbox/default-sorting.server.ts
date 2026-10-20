import type { Logger } from "@/utils/logger";
import prisma from "@/utils/prisma";
import { setUpCueSorting } from "@/utils/split-inbox/cue-tabs.server";

/**
 * Gives a mailbox that has no rules Cue's default sorting, once: the reply
 * tracking rules every inbox style card answer adds, with no actions and no
 * tabs, so nothing is written to the mailbox and whatever the person picks on
 * the card later only adds to it. The newest inbox mail is then sorted in the
 * background, behind the first sync.
 *
 * A mailbox whose person already decided is only marked as checked: one with
 * rules, even turned off, and one Cue sorted before, whose rules were deleted.
 * Picking an inbox style or deleting a rule marks it too. An inbox style
 * picked before every answer added reply tracking is no such choice, so it
 * gets the defaults. The marker is claimed before anything is created, so
 * concurrent syncs add the defaults once, and released if setting up fails
 * before any rule exists, so the next sync tries again.
 *
 * Returns whether the defaults were added.
 */
export async function ensureDefaultCueSorting({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) {
  const checkedAt = new Date();
  const claim = await prisma.emailAccount.updateMany({
    where: { id: emailAccountId, defaultSortingCheckedAt: null },
    data: { defaultSortingCheckedAt: checkedAt },
  });
  if (!claim.count) return false;

  const release = () =>
    prisma.emailAccount.updateMany({
      where: { id: emailAccountId, defaultSortingCheckedAt: checkedAt },
      data: { defaultSortingCheckedAt: null, defaultSortingAppliedAt: null },
    });

  try {
    if (await hasSortingChoice(emailAccountId)) {
      logger.info("Kept the mailbox's own sorting choice");
      return false;
    }
    await prisma.emailAccount.updateMany({
      where: { id: emailAccountId, defaultSortingCheckedAt: checkedAt },
      data: { defaultSortingAppliedAt: checkedAt },
    });
  } catch (error) {
    await release();
    throw error;
  }

  try {
    await setUpCueSorting({
      emailAccountId,
      provider,
      addTabs: false,
      backfillPriority: "background",
      logger,
    });
  } catch (error) {
    // Once rules exist the mailbox is sorted from the next push on; only the
    // sort of its latest mail is lost. Trying again would also leave the old
    // history cursor in place, replaying the whole backlog at sync priority.
    const created = await prisma.rule.findFirst({
      where: { emailAccountId },
      select: { id: true },
    });
    if (!created) {
      await release();
      throw error;
    }
    logger.error("Added default Cue sorting but could not sort recent mail", {
      error,
    });
  }

  logger.info("Added default Cue sorting to a mailbox with no rules");
  return true;
}

/** Records that the person decided how this mailbox is sorted. */
export async function markSortingChoice(emailAccountId: string) {
  await prisma.emailAccount.updateMany({
    where: { id: emailAccountId, defaultSortingCheckedAt: null },
    data: { defaultSortingCheckedAt: new Date() },
  });
}

async function hasSortingChoice(emailAccountId: string) {
  const [rule, executedRule] = await Promise.all([
    prisma.rule.findFirst({ where: { emailAccountId }, select: { id: true } }),
    prisma.executedRule.findFirst({
      where: { emailAccountId },
      select: { id: true },
    }),
  ]);
  return !!rule || !!executedRule;
}
