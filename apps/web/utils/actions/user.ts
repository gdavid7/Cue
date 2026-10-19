"use server";

import { z } from "zod";
import { after } from "next/server";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import { deleteUser } from "@/utils/user/delete";
import { stopWatchingEmailAccount } from "@/utils/email/watch-manager";
import { actionClient, actionClientUser } from "@/utils/actions/safe-action";
import { captureException, SafeError } from "@/utils/error";
import { updateAccountSeats } from "@/utils/premium/seats";
import { betterAuthConfig } from "@/utils/auth";
import { cookies, headers } from "next/headers";
import {
  LAST_EMAIL_ACCOUNT_COOKIE,
  parseLastEmailAccountCookieValue,
} from "@/utils/cookies";
import {
  saveAboutBody,
  saveSignatureBody,
  saveWritingStyleBody,
  updateAIDraftCleanupSettingsBody,
} from "@/utils/actions/user.validation";
import { clearLastEmailAccountCookie } from "@/utils/cookies.server";
import { deleteTinybirdEmailData } from "@inboxzero/tinybird";
import { aliasPosthogUser } from "@/utils/posthog";
import {
  cleanupAIDraftsForAccount,
  getConfiguredDraftCleanupDays,
} from "@/utils/ai/draft-cleanup";
import { isDuplicateError, isNotFoundError } from "@/utils/prisma-helpers";
import { type Logger, toLogJson } from "@/utils/logger";
import {
  getMoveSharedConnectionsOperations,
  remainingEmailAccountQuery,
} from "@/utils/user/move-shared-connections";
import { shareChannelsAcrossMailboxes } from "@/utils/messaging/shared-channels";
import { prepareMemberRemovalNotifications } from "@/utils/team-comments/member-removal";
import {
  DELETE_ACCOUNT_REQUIRES_OWNER_TRANSFER_ERROR,
  DELETE_EMAIL_ACCOUNT_REQUIRES_OWNER_TRANSFER_ERROR,
  getDeletableOrganizationIdsOrThrow,
  getDeletedAccountOwnershipImpact,
  getDeleteSoloOrganizationsOperation,
  getUserDeletionOwnershipImpact,
  isMemberEmailAccountForeignKeyError,
  isOrganizationOwnerInvariantError,
} from "@/utils/organizations/ownership";
import { invalidateAccountOwnership } from "@/utils/redis/account-validation";
import {
  getGoogleGrants,
  revokeGoogleGrants,
} from "@/utils/user/revoke-google-grants";

export const saveAboutAction = actionClient
  .metadata({ name: "saveAbout" })
  .inputSchema(saveAboutBody)
  .action(async ({ parsedInput: { about }, ctx: { emailAccountId } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { about },
    });
  });

export const saveSignatureAction = actionClient
  .metadata({ name: "saveSignature" })
  .inputSchema(saveSignatureBody)
  .action(async ({ parsedInput: { signature }, ctx: { emailAccountId } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { signature },
    });
  });

export const saveWritingStyleAction = actionClient
  .metadata({ name: "saveWritingStyle" })
  .inputSchema(saveWritingStyleBody)
  .action(
    async ({ parsedInput: { writingStyle }, ctx: { emailAccountId } }) => {
      await prisma.emailAccount.update({
        where: { id: emailAccountId },
        data: { writingStyle },
      });
    },
  );

export const resetAnalyticsAction = actionClient
  .metadata({ name: "resetAnalytics" })
  .action(async ({ ctx: { emailAccountId } }) => {
    await prisma.emailMessage.deleteMany({
      where: { emailAccountId },
    });
  });

export const deleteAccountAction = actionClientUser
  .metadata({ name: "deleteAccount" })
  .action(async ({ ctx: { userId, logger } }) => {
    await assertUserAccountCanBeDeleted(userId);

    await clearLastEmailAccountCookie().catch((error) => {
      logger.error("Failed to clear last email account cookie", { error });
    });

    await betterAuthConfig.api
      .signOut({
        headers: await headers(),
      })
      .catch((error) => {
        logger.error("Failed to sign out", { error });
      });
    await deleteUser({ userId, logger });
  });

export const cleanupAIDraftsAction = actionClient
  .metadata({ name: "cleanupAIDrafts", gmailPriority: "sync" })
  .action(async ({ ctx: { emailAccountId, provider, logger } }) => {
    const cleanupDays = await getConfiguredDraftCleanupDays(emailAccountId);
    return cleanupAIDraftsForAccount({
      emailAccountId,
      provider,
      logger,
      cleanupDays,
    });
  });

export const updateAIDraftCleanupSettingsAction = actionClient
  .metadata({ name: "updateAIDraftCleanupSettings" })
  .inputSchema(updateAIDraftCleanupSettingsBody)
  .action(async ({ parsedInput: { cleanupDays }, ctx: { emailAccountId } }) => {
    await prisma.emailAccount.update({
      where: { id: emailAccountId },
      data: { draftCleanupDays: cleanupDays },
    });

    return { cleanupDays };
  });

export const deleteEmailAccountAction = actionClientUser
  .metadata({ name: "deleteEmailAccount" })
  .inputSchema(z.object({ emailAccountId: z.string() }))
  .action(
    async ({
      ctx: { userId, userEmail, logger },
      parsedInput: { emailAccountId },
    }) => {
      const emailAccount = await prisma.emailAccount.findUnique({
        where: { id: emailAccountId, userId },
        select: {
          email: true,
          accountId: true,
          watchEmailsSubscriptionId: true,
          account: { select: { provider: true } },
          user: { select: { email: true } },
        },
      });

      if (!emailAccount) throw new SafeError("Email account not found");
      if (!emailAccount.accountId) throw new SafeError("Account id not found");
      const organizationIdsToDelete =
        await assertEmailAccountCanBeDeleted(emailAccountId);
      const notifyConversations = await prepareMemberRemovalNotifications(
        { emailAccountId },
        logger,
      );

      const isPrimaryAccount = emailAccount.email === emailAccount.user.email;
      const deleteSoloOrganizationsOperation =
        getDeleteSoloOrganizationsOperation(organizationIdsToDelete, [
          emailAccountId,
        ]);
      const deleteRemainingMembershipsOperation = prisma.member.deleteMany({
        where: {
          emailAccountId,
          organizationId: { notIn: organizationIdsToDelete },
        },
      });

      // The oldest other mailbox: the next primary, and where shared
      // connections move.
      const remainingEmailAccount = await prisma.emailAccount.findFirst({
        ...remainingEmailAccountQuery({
          userId,
          removedEmailAccountId: emailAccountId,
        }),
        select: { id: true, email: true, name: true, image: true },
      });

      if (isPrimaryAccount && !remainingEmailAccount) {
        throw new SafeError(
          "Cannot delete your only email account. Go to the Settings page to delete your entire account.",
        );
      }

      const moveSharedConnections = await prepareSharedConnectionsMove({
        userId,
        emailAccountId,
        remainingEmailAccountId: remainingEmailAccount?.id,
        logger,
      });

      await stopWatchingEmailAccount({
        emailAccountId,
        provider: emailAccount.account.provider,
        subscriptionId: emailAccount.watchEmailsSubscriptionId,
        logger,
      });

      // Read before the delete removes them; revoked only once it commits.
      const googleGrants = await getGoogleGrants({
        where: { id: emailAccount.accountId, userId },
        logger,
      });

      if (isPrimaryAccount && remainingEmailAccount) {
        // Promote the next email account to primary
        const newPrimaryAccount = remainingEmailAccount;
        const oldEmail = emailAccount.user.email;

        await runDeleteEmailAccountTransaction(
          userId,
          [
            deleteSoloOrganizationsOperation,
            deleteRemainingMembershipsOperation,
            prisma.user.update({
              where: {
                id: userId,
                email: oldEmail,
                emailAccounts: { some: { id: newPrimaryAccount.id } },
              },
              data: {
                email: newPrimaryAccount.email,
                name: newPrimaryAccount.name,
                image: newPrimaryAccount.image,
              },
            }),
            ...moveSharedConnections,
            prisma.emailAccount.delete({
              where: {
                id: emailAccountId,
                userId,
                accountId: emailAccount.accountId,
              },
            }),
            prisma.account.delete({
              where: { id: emailAccount.accountId, userId },
            }),
          ],
          { emailAccountId, logger, userEmail },
        );

        // Alias the old PostHog identity to the new one
        after(async () => {
          await aliasPosthogUser({
            oldEmail,
            newEmail: newPrimaryAccount.email,
          });
        });
      } else {
        await runDeleteEmailAccountTransaction(
          userId,
          [
            deleteSoloOrganizationsOperation,
            deleteRemainingMembershipsOperation,
            ...moveSharedConnections,
            prisma.emailAccount.delete({
              where: {
                id: emailAccountId,
                userId,
                accountId: emailAccount.accountId,
                user: { email: emailAccount.user.email },
              },
            }),
            prisma.account.delete({
              where: { id: emailAccount.accountId, userId },
            }),
          ],
          { emailAccountId, logger, userEmail },
        );
      }

      await revokeGoogleGrants({ grants: googleGrants, logger });

      after(() =>
        deleteTinybirdEmailData([emailAccount.email]).catch((error) => {
          logger.error("Error deleting Tinybird data", { error });
          captureException(error);
        }),
      );

      await notifyConversations();

      await clearLastEmailAccountCookieIfMatching({
        userId,
        emailAccountId,
        logger,
      });

      after(async () => {
        await updateAccountSeats({ userId });
      });
    },
  );

/**
 * Calendars, Drive, connected apps and Slack/Teams links serve all of a
 * person's mailboxes, so removing the one they were connected from must not
 * take them from the others (MA-7). Messaging links are copied to every
 * remaining mailbox now; the rest move in the delete's transaction.
 */
async function prepareSharedConnectionsMove({
  userId,
  emailAccountId,
  remainingEmailAccountId,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  remainingEmailAccountId: string | undefined;
  logger: Logger;
}) {
  if (!remainingEmailAccountId) return [];
  await shareChannelsAcrossMailboxes({ userId, logger });
  return getMoveSharedConnectionsOperations({
    userId,
    fromEmailAccountId: emailAccountId,
    toEmailAccountId: remainingEmailAccountId,
  });
}

async function runDeleteEmailAccountTransaction(
  userId: string,
  operations: Prisma.PrismaPromise<unknown>[],
  context: {
    emailAccountId: string;
    logger: Logger;
    userEmail?: string | null;
  },
) {
  try {
    await prisma.$transaction([
      prisma.$queryRaw`
        SELECT true AS locked
        FROM (
          SELECT pg_advisory_xact_lock(539114481, hashtext(${userId}))
        ) lock
      `,
      ...operations,
    ]);
  } catch (error) {
    context.logger.error("Delete email account transaction failed", {
      error,
      emailAccountId: context.emailAccountId,
      prismaCode: getPrismaErrorCode(error),
      prismaMeta: toLogJson(getPrismaErrorMeta(error)),
    });

    if (isNotFoundError(error)) {
      throw new SafeError("Email account already changed");
    }

    if (isDuplicateError(error, "email")) {
      throw new SafeError(
        "We couldn't make the remaining email account primary because that email is already in use.",
      );
    }

    if (
      isOrganizationOwnerInvariantError(error) ||
      isMemberEmailAccountForeignKeyError(error)
    ) {
      throw new SafeError(DELETE_EMAIL_ACCOUNT_REQUIRES_OWNER_TRANSFER_ERROR);
    }

    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2003"
    ) {
      throw new SafeError(
        "We couldn't delete this email account because linked data still exists. Please contact support.",
      );
    }

    captureException(error, {
      userId,
      userEmail: context.userEmail ?? undefined,
      emailAccountId: context.emailAccountId,
      extra: { action: "deleteEmailAccount" },
    });

    throw new SafeError(
      "We couldn't delete this email account. Please contact support if this keeps happening.",
    );
  }

  await invalidateAccountOwnership({
    userId,
    emailAccountId: context.emailAccountId,
  });
}

function getPrismaErrorCode(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.code
    : undefined;
}

function getPrismaErrorMeta(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError
    ? error.meta
    : undefined;
}

async function assertEmailAccountCanBeDeleted(emailAccountId: string) {
  const ownershipImpact = await getDeletedAccountOwnershipImpact([
    emailAccountId,
  ]);

  return getDeletableOrganizationIdsOrThrow(
    ownershipImpact,
    DELETE_EMAIL_ACCOUNT_REQUIRES_OWNER_TRANSFER_ERROR,
  );
}

async function clearLastEmailAccountCookieIfMatching({
  userId,
  emailAccountId,
  logger,
}: {
  userId: string;
  emailAccountId: string;
  logger: Logger;
}) {
  try {
    const cookieStore = await cookies();
    const lastEmailAccountId = parseLastEmailAccountCookieValue({
      userId,
      cookieValue: cookieStore.get(LAST_EMAIL_ACCOUNT_COOKIE)?.value,
    });
    if (lastEmailAccountId !== emailAccountId) return;
    await clearLastEmailAccountCookie();
  } catch (error) {
    logger.error("Failed to clear last email account cookie", { error });
  }
}

async function assertUserAccountCanBeDeleted(userId: string) {
  const ownershipImpact = await getUserDeletionOwnershipImpact(userId);

  getDeletableOrganizationIdsOrThrow(
    ownershipImpact,
    DELETE_ACCOUNT_REQUIRES_OWNER_TRANSFER_ERROR,
  );
}
