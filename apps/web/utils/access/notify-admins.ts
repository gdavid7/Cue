import { deliverTransactionalEmail } from "@inboxzero/transactional-email/src/delivery";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";
import type { Logger } from "@/utils/logger";

/**
 * Tells the admins a new person asked for access. Never throws: the person's
 * request is already saved, and a missed email must not fail it.
 */
export async function notifyAdminsOfAccessRequest({
  requestId,
  email,
  logger,
}: {
  requestId: string;
  email: string;
  logger: Logger;
}) {
  const admins = env.ADMINS ?? [];
  if (!admins.length) return;

  const lines = [
    "A new access request is waiting.",
    `Requested by: ${email}`,
    `Review it: ${env.NEXT_PUBLIC_BASE_URL}/admin/access`,
  ];

  try {
    const result = await deliverTransactionalEmail(
      {
        from: env.RESEND_FROM_EMAIL,
        to: admins,
        // The requester's address stays out of the subject line.
        subject: `New ${BRAND_NAME} access request`,
        text: lines.join("\n"),
        html: lines.map((line) => `<p>${escapeHtml(line)}</p>`).join(""),
      },
      { idempotencyKey: `access-request-notify:${requestId}` },
    );
    if (!result) logger.warn("Access request notification not sent");
  } catch (error) {
    logger.error("Failed to notify admins of an access request", { error });
  }
}

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
