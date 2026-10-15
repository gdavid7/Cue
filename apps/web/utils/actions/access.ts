"use server";

import { headers } from "next/headers";
import { env } from "@/env";
import prisma from "@/utils/prisma";
import {
  adminActionClient,
  publicActionClient,
} from "@/utils/actions/safe-action";
import {
  accessRequestIdBody,
  approveAccessEmailBody,
  approveAccessRequestsBody,
  requestAccessBody,
} from "@/utils/actions/access.validation";
import {
  normalizeAccessEmail,
  recordAccessRequest,
} from "@/utils/access/policy";
import { ACCESS_APPROVAL_EMAIL_DELIVERY } from "@/utils/access/config";
import { getApprovalEmail } from "@/utils/access/approval-email";
import { createEmailProvider } from "@/utils/email/provider";
import {
  checkRateLimit,
  createRateLimitKey,
  getClientIp,
  hashRateLimitValue,
} from "@/utils/rate-limit";
import { posthogCaptureEvent } from "@/utils/posthog";
import { ONBOARDING_ANALYTICS_EVENTS } from "@/utils/analytics/product";
import { SafeError } from "@/utils/error";
import type { Logger } from "@/utils/logger";

const RATE_LIMITED_MESSAGE = "Too many requests. Try again in a little while.";
const REQUEST_RATE_LIMITS = {
  ipHourly: { limit: 5, windowSeconds: 60 * 60 },
  emailDaily: { limit: 3, windowSeconds: 24 * 60 * 60 },
} as const;

/**
 * The same answer for a new, pending, approved or declined address, so the
 * form never reveals anyone's status.
 */
export const requestAccessAction = publicActionClient
  .metadata({ name: "requestAccess" })
  .inputSchema(requestAccessBody)
  .action(async ({ parsedInput: { email, website }, ctx: { logger } }) => {
    if (website) {
      logger.info("Dropped an access request that filled the honeypot");
      return { ok: true };
    }

    const normalizedEmail = normalizeAccessEmail(email);
    await enforceRequestRateLimit({
      clientIp: getClientIp(await headers()),
      email: normalizedEmail,
      logger,
    });

    const request = await recordAccessRequest({
      email: normalizedEmail,
      source: "form",
    });
    logger.trace("Access requested", { email: normalizedEmail });
    if (!request.isRepeat && request.id) {
      await posthogCaptureEvent(
        `access_request:${request.id}`,
        ONBOARDING_ANALYTICS_EVENTS.accessRequested,
        { source: "form" },
      );
    }

    return { ok: true };
  });

/** Approves people who asked. Already-approved rows are left as they were. */
export const approveAccessRequestsAction = adminActionClient
  .metadata({ name: "approveAccessRequests" })
  .inputSchema(approveAccessRequestsBody)
  .action(async ({ parsedInput: { ids }, ctx: { session, logger } }) => {
    const requests = await prisma.accessRequest.findMany({
      where: { id: { in: ids }, status: { not: "APPROVED" } },
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (!requests.length) return { approved: [] };

    const decidedAt = new Date();
    await prisma.accessRequest.updateMany({
      where: { id: { in: requests.map((request) => request.id) } },
      data: {
        status: "APPROVED",
        decidedAt,
        decidedBy: session.user.email,
      },
    });

    const approved = [];
    for (const request of requests) {
      const emailed = await deliverApprovalEmail({
        request,
        admin: session.user,
        logger,
      });
      approved.push({ id: request.id, email: request.email, emailed });
      await posthogCaptureEvent(
        `access_request:${request.id}`,
        ONBOARDING_ANALYTICS_EVENTS.accessApproved,
        {
          days_pending: Math.floor(
            (decidedAt.getTime() - request.createdAt.getTime()) / 86_400_000,
          ),
          batch_size: requests.length,
        },
      );
    }

    return { approved };
  });

/**
 * Lets the founder approve anyone directly, without a request first. Returns
 * the address as stored, which is the one sign-in is matched against.
 */
export const approveAccessEmailAction = adminActionClient
  .metadata({ name: "approveAccessEmail" })
  .inputSchema(approveAccessEmailBody)
  .action(async ({ parsedInput: { email }, ctx: { session, logger } }) => {
    const normalizedEmail = normalizeAccessEmail(email);
    const existing = await prisma.accessRequest.findUnique({
      where: { email: normalizedEmail },
      select: { id: true, status: true },
    });
    if (existing?.status === "APPROVED")
      return {
        id: existing.id,
        email: normalizedEmail,
        approved: [],
        alreadyApproved: true,
      };

    const request = await prisma.accessRequest.upsert({
      where: { email: normalizedEmail },
      create: {
        email: normalizedEmail,
        source: "admin",
        status: "APPROVED",
        decidedAt: new Date(),
        decidedBy: session.user.email,
      },
      update: {
        status: "APPROVED",
        decidedAt: new Date(),
        decidedBy: session.user.email,
      },
      select: { id: true, email: true, name: true },
    });
    const emailed = await deliverApprovalEmail({
      request,
      admin: session.user,
      logger,
    });

    return {
      id: request.id,
      email: request.email,
      approved: [{ id: request.id, email: request.email, emailed }],
      alreadyApproved: false,
    };
  });

/** No email is sent; the person keeps seeing "You're on the list". */
export const declineAccessRequestAction = adminActionClient
  .metadata({ name: "declineAccessRequest" })
  .inputSchema(accessRequestIdBody)
  .action(async ({ parsedInput: { id }, ctx: { session } }) => {
    const result = await prisma.accessRequest.updateMany({
      where: { id, status: "PENDING" },
      data: {
        status: "DECLINED",
        decidedAt: new Date(),
        decidedBy: session.user.email,
      },
    });
    if (result.count === 0)
      throw new SafeError("Only pending requests can be declined");
    await posthogCaptureEvent(
      `access_request:${id}`,
      ONBOARDING_ANALYTICS_EVENTS.accessDeclined,
    );
  });

export const markAccessRequestNotifiedAction = adminActionClient
  .metadata({ name: "markAccessRequestNotified" })
  .inputSchema(accessRequestIdBody)
  .action(async ({ parsedInput: { id } }) => {
    await prisma.accessRequest.updateMany({
      where: { id, status: "APPROVED", notifiedAt: null },
      data: { notifiedAt: new Date() },
    });
  });

/**
 * Moves the AUTH_ALLOWED_EMAILS list onto the waitlist as approved, so the
 * env list can shrink to the founder. These people already had access, so
 * nobody is emailed.
 */
export const importAllowlistAction = adminActionClient
  .metadata({ name: "importAllowlist" })
  .action(async () => {
    const emails = [
      ...new Set(
        (env.AUTH_ALLOWED_EMAILS ?? [])
          .map(normalizeAccessEmail)
          .filter(Boolean),
      ),
    ];
    if (!emails.length) return { imported: 0 };

    const now = new Date();
    const decision = {
      status: "APPROVED" as const,
      decidedAt: now,
      decidedBy: "migration",
      notifiedAt: now,
    };
    await prisma.accessRequest.createMany({
      data: emails.map((email) => ({
        email,
        source: "allowlist",
        ...decision,
      })),
      skipDuplicates: true,
    });
    await prisma.accessRequest.updateMany({
      where: { email: { in: emails }, status: { not: "APPROVED" } },
      data: decision,
    });

    return { imported: emails.length };
  });

async function deliverApprovalEmail({
  request,
  admin,
  logger,
}: {
  request: { id: string; email: string; name: string | null };
  admin: { email: string; name?: string | null };
  logger: Logger;
}) {
  if (ACCESS_APPROVAL_EMAIL_DELIVERY !== "founder-mailbox") return false;

  const mailbox = await prisma.emailAccount.findUnique({
    where: { email: admin.email.trim().toLowerCase() },
    select: { id: true, account: { select: { provider: true } } },
  });
  if (!mailbox) {
    logger.warn("Approval email not sent: the admin has no connected mailbox");
    return false;
  }

  try {
    const provider = await createEmailProvider({
      emailAccountId: mailbox.id,
      provider: mailbox.account.provider,
      logger,
    });
    const message = getApprovalEmail({
      email: request.email,
      name: request.name,
      baseUrl: env.NEXT_PUBLIC_BASE_URL,
      senderName: admin.name,
    });
    await provider.sendEmail({
      to: request.email,
      subject: message.subject,
      messageText: message.body,
    });
    await prisma.accessRequest.update({
      where: { id: request.id },
      data: { notifiedAt: new Date() },
    });
    return true;
  } catch (error) {
    // The approval stands; the admin page offers the manual email instead.
    logger.error("Failed to send approval email", { error });
    return false;
  }
}

async function enforceRequestRateLimit({
  clientIp,
  email,
  logger,
}: {
  clientIp: string;
  email: string;
  logger: Logger;
}) {
  const rules = [
    {
      ...REQUEST_RATE_LIMITS.ipHourly,
      key: createRateLimitKey([
        "rate-limit",
        "access-request",
        "ip",
        hashRateLimitValue(clientIp),
      ]),
    },
    {
      ...REQUEST_RATE_LIMITS.emailDaily,
      key: createRateLimitKey([
        "rate-limit",
        "access-request",
        "email",
        hashRateLimitValue(email),
      ]),
    },
  ];
  for (const rule of rules) {
    const result = await checkRateLimit({ rule, logger });
    if (result.limited) throw new SafeError(RATE_LIMITED_MESSAGE, 429);
  }
}
