import { deliverTransactionalEmail } from "@inboxzero/transactional-email/src/delivery";
import { env } from "@/env";
import { BRAND_NAME } from "@/utils/branding";
import { checkRateLimit, createRateLimitKey } from "@/utils/rate-limit";
import type { Logger } from "@/utils/logger";

const NOTIFY_RATE_LIMIT = { limit: 20, windowSeconds: 60 * 60 } as const;

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

  // A flood of requests must not become a flood of founder email.
  const rateLimit = await checkRateLimit({
    rule: {
      key: createRateLimitKey(["access-request-notify"]),
      ...NOTIFY_RATE_LIMIT,
    },
    logger,
  });
  if (rateLimit.limited) {
    logger.warn("Access request notification skipped: hourly cap reached", {
      limit: rateLimit.limit,
    });
    return;
  }

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
