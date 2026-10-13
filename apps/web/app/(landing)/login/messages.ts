import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";

/**
 * Sign-in problems point at this deployment's own support. The support email
 * still defaults to the upstream project's address, so it isn't offered here.
 */
export function getSignInSupportText() {
  return env.NEXT_PUBLIC_CRISP_WEBSITE_ID
    ? "If this keeps happening, use the support chat."
    : `If this keeps happening, contact the ${BRAND_NAME} team.`;
}

export function getRequiresReconsentDescription(options?: {
  includeSupportText?: boolean;
}) {
  const description = `Please sign in again and approve every requested permission. If your Microsoft 365 organization requires admin approval, ask your admin to approve ${BRAND_NAME} first.`;

  if (!options?.includeSupportText) return description;

  return `${description} ${getSignInSupportText()}`;
}

export function getEmailAlreadyLinkedDescription(options?: {
  includeSupportText?: boolean;
}) {
  const description = `This mailbox is already connected to another ${BRAND_NAME} account. To use it, sign in with the original account that owns this mailbox, then reconnect the mailbox from Accounts if needed. If you can't access that account or believe this is a duplicate, contact support so we can help recover or merge the accounts.`;

  if (!options?.includeSupportText) return description;

  return `${description} ${getSignInSupportText()}`;
}
