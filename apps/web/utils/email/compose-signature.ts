import { env } from "@/env";
import prisma from "@/utils/prisma";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";
import { createEmailProvider } from "@/utils/email/provider";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { renderSentWithFooterHtml } from "@/utils/email/sent-with-footer";
import { getOrCreateReferralCode } from "@/utils/referral/referral-code";
import { generateReferralLink } from "@/utils/referral/referral-link";

/**
 * The signature and "Sent with" footer every composer adds to a new message,
 * so web and the mobile apps send the same thing.
 */
export async function getComposeSignature({
  emailAccountId,
  userId,
  logger,
}: {
  emailAccountId: string;
  userId: string;
  logger: Logger;
}) {
  const emailAccount = await prisma.emailAccount.findUnique({
    where: { id: emailAccountId },
    select: {
      signature: true,
      includeSentWithSignature: true,
      account: { select: { provider: true } },
    },
  });
  if (!emailAccount) throw new SafeError("Email account not found");

  const includeFooter =
    !env.NEXT_PUBLIC_DISABLE_REFERRAL_SIGNATURE &&
    emailAccount.includeSentWithSignature;
  return {
    signatureHtml:
      emailAccount.signature ??
      (await importGmailSignature({
        emailAccountId,
        provider: emailAccount.account.provider,
        logger,
      })),
    footerHtml: includeFooter
      ? renderSentWithFooterHtml(await getFooterLink(userId))
      : "",
  };
}

/**
 * A signature that was never set (null, unlike one cleared to "") is taken once
 * from Gmail's default send-as address, so mail sent from Cue signs off the way
 * the person's Gmail already does. Outlook's signature isn't readable.
 */
async function importGmailSignature({
  emailAccountId,
  provider,
  logger,
}: {
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) {
  if (!isGoogleProvider(provider)) return "";

  try {
    const emailProvider = await createEmailProvider({
      emailAccountId,
      provider,
      logger,
    });
    const signatures = await emailProvider.getSignatures();
    const signature =
      signatures.find((item) => item.isDefault)?.signature.trim() ?? "";

    // Saved even when empty so Gmail is asked once, and only while still unset
    // so a signature the person saved in the meantime is never overwritten.
    await prisma.emailAccount.updateMany({
      where: { id: emailAccountId, signature: null },
      data: { signature },
    });
    return signature;
  } catch (error) {
    logger.warn("Could not import the Gmail signature", { error });
    return "";
  }
}

// A failed referral lookup still sends the footer, just without the referral link.
async function getFooterLink(userId: string) {
  try {
    const { code } = await getOrCreateReferralCode(userId);
    return generateReferralLink(code);
  } catch {
    return env.NEXT_PUBLIC_BASE_URL;
  }
}
