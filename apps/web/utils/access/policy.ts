import { env } from "@/env";
import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { posthogCaptureEvent } from "@/utils/posthog";
import { ONBOARDING_ANALYTICS_EVENTS } from "@/utils/analytics/product";
import {
  isAllowedAuthSignupEmail,
  createSignupNotAllowedError,
  isListedInAuthAllowlist,
} from "@/utils/auth-signup-policy";

type AccessPolicy = {
  waitlistEnabled: boolean;
  admins: readonly string[];
  allowedEmails: readonly string[];
  allowedDomains: readonly string[];
};

/**
 * Runs where a new `User` row would be created, so people who already have an
 * account are never checked again. With the waitlist off and no allow-list,
 * sign-up stays open (local dev and self-hosting). An allow-list on its own
 * gates sign-up as before, and also admits people approved on /admin/access.
 */
export async function assertSignUpAllowed(
  { email, name }: { email: string; name?: string | null },
  policy: AccessPolicy = getAccessPolicy(),
) {
  if (!policy.waitlistEnabled && isAllowedAuthSignupEmail(email, policy))
    return;

  if (await isApprovedForAccess(email, policy)) return;

  // The person tried to get in, so that counts as asking. Google has already
  // shown its consent screen, but nothing from it is kept.
  const request = await recordAccessRequest({
    email,
    name,
    source: "google_sign_in",
  });
  if (!request.isRepeat && request.id) {
    await posthogCaptureEvent(
      `access_request:${request.id}`,
      ONBOARDING_ANALYTICS_EVENTS.accessRequested,
      { source: "google_sign_in" },
    );
  }
  throw createSignupNotAllowedError();
}

export async function isApprovedForAccess(
  email: string,
  policy: AccessPolicy = getAccessPolicy(),
) {
  const normalizedEmail = normalizeAccessEmail(email);
  if (!normalizedEmail) return false;
  if (
    policy.admins.some(
      (admin) => normalizeAccessEmail(admin) === normalizedEmail,
    )
  )
    return true;
  if (isListedInAuthAllowlist(normalizedEmail, policy)) return true;

  const request = await prisma.accessRequest.findUnique({
    where: { email: normalizedEmail },
    select: { status: true },
  });
  return request?.status === "APPROVED";
}

/** Adds a pending request once; an existing decision is never undone. */
export async function recordAccessRequest({
  email,
  name,
  source,
}: {
  email: string;
  name?: string | null;
  source: "form" | "google_sign_in";
}) {
  const normalizedEmail = normalizeAccessEmail(email);
  const existing = await prisma.accessRequest.findUnique({
    where: { email: normalizedEmail },
    select: { id: true },
  });
  if (existing) return { id: existing.id, isRepeat: true };

  try {
    const created = await prisma.accessRequest.create({
      data: { email: normalizedEmail, name: name || null, source },
      select: { id: true },
    });
    return { id: created.id, isRepeat: false };
  } catch (error) {
    // Two submissions raced; the other one recorded it.
    if (isDuplicateError(error, "email")) return { id: null, isRepeat: true };
    throw error;
  }
}

export function normalizeAccessEmail(email: string) {
  return email.trim().toLowerCase();
}

function getAccessPolicy(): AccessPolicy {
  return {
    waitlistEnabled: env.AUTH_WAITLIST_ENABLED,
    admins: env.ADMINS ?? [],
    allowedEmails: env.AUTH_ALLOWED_EMAILS ?? [],
    allowedDomains: env.AUTH_ALLOWED_EMAIL_DOMAINS ?? [],
  };
}
