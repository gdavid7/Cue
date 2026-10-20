import { env } from "@/env";
import prisma from "@/utils/prisma";
import { isDuplicateError } from "@/utils/prisma-helpers";
import { posthogCaptureEvent } from "@/utils/posthog";
import { ONBOARDING_ANALYTICS_EVENTS } from "@/utils/analytics/product";
import {
  isAllowedAuthSignupEmail,
  isAuthSignupOpen,
  createSignupNotAllowedError,
  isListedInAuthAllowlist,
} from "@/utils/auth-signup-policy";
import { GMAIL_DOMAINS } from "@/utils/access/config";
import { notifyAdminsOfAccessRequest } from "@/utils/access/notify-admins";
import { deferCallbackStep } from "@/utils/oauth/callback-timings";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("access/policy");

/**
 * Sign-in providers whose email claim proves the person owns the address.
 * Microsoft's can be set by a tenant admin (see utils/auth/account-linking.ts),
 * so it can't stand in for an approved or allow-listed address.
 */
const PROVIDERS_THAT_PROVE_EMAIL = new Set(["google", "apple"]);

type AccessPolicy = {
  waitlistEnabled: boolean;
  admins: readonly string[];
  allowedEmails: readonly string[];
  allowedDomains: readonly string[];
};

/**
 * Runs where a new `User` row would be created, so people who already have an
 * account are never checked again. With the waitlist off and no allow-list,
 * sign-up stays open to any provider (local dev and self-hosting). Otherwise a
 * Google or Apple sign-in that proves the address must be allow-listed or
 * approved on /admin/access.
 */
export async function assertSignUpAllowed(
  {
    email,
    name,
    provider,
    emailVerified,
  }: {
    email: string;
    name?: string | null;
    /** The sign-in provider id, e.g. "google". */
    provider?: string;
    emailVerified?: boolean;
  },
  policy: AccessPolicy = getAccessPolicy(),
) {
  if (!policy.waitlistEnabled && isAuthSignupOpen(policy)) return;

  // Approvals and the allow-list both name an address, so only a sign-in that
  // proves the address can use them. An unproven claim isn't recorded as that
  // person's request. Google's claim is narrowed to addresses it is
  // authoritative for when its profile is mapped (utils/auth/account-linking).
  const provesEmail =
    !!provider &&
    PROVIDERS_THAT_PROVE_EMAIL.has(provider) &&
    emailVerified === true;
  if (!provesEmail) throw createSignupNotAllowedError();

  // Covers AUTH_ALLOWED_EMAILS (and domains with the waitlist off) too.
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
    const requestId = request.id;
    // Sign-in is waiting on this check, so the email can't hold it up.
    deferCallbackStep(
      "access.notifyAdmins",
      () =>
        notifyAdminsOfAccessRequest({
          requestId,
          email: normalizeAccessEmail(email),
          logger,
        }),
      logger,
    );
  }
  throw createSignupNotAllowedError();
}

/**
 * The sign-up rule for an address whose owner the sign-in already proved:
 * with the waitlist off, the env allow-list (empty means open) or an approval;
 * with it on, an approval.
 */
export async function isAllowedProvenEmail(
  email: string,
  policy: AccessPolicy = getAccessPolicy(),
) {
  if (!policy.waitlistEnabled && isAllowedAuthSignupEmail(email, policy))
    return true;
  return isApprovedForAccess(email, policy);
}

/**
 * Google is authoritative only for Gmail and Workspace (`hd`) addresses. A
 * consumer Google account registered with another provider's address keeps
 * `email_verified` after its owner loses that address, so it proves nothing.
 */
export function isGoogleAuthoritativeEmail({
  email,
  emailVerified,
  hostedDomain,
}: {
  email?: string;
  emailVerified?: boolean;
  hostedDomain?: string;
}) {
  if (emailVerified !== true || !email) return false;
  if (hostedDomain) return true;
  const domain = lowercaseEmail(email).split("@").pop() ?? "";
  return GMAIL_DOMAINS.includes(domain);
}

export async function isApprovedForAccess(
  email: string,
  policy: AccessPolicy = getAccessPolicy(),
) {
  const normalizedEmail = normalizeAccessEmail(email);
  if (!normalizedEmail) return false;
  const isNamed = (listed: string) =>
    normalizeAccessEmail(listed) === normalizedEmail;
  if (policy.admins.some(isNamed)) return true;
  if (policy.allowedEmails.some(isNamed)) return true;
  // A domain list approves everyone at it, which the waitlist doesn't allow:
  // with it on, each person is approved individually.
  if (
    !policy.waitlistEnabled &&
    isListedInAuthAllowlist(normalizedEmail, {
      allowedDomains: policy.allowedDomains,
    })
  )
    return true;

  const request = await prisma.accessRequest.findFirst({
    where: {
      // The plain lowercase form also matches rows stored before addresses
      // were stored in canonical Gmail form.
      email: { in: [...new Set([normalizedEmail, lowercaseEmail(email)])] },
      status: "APPROVED",
    },
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

/**
 * The form approvals are stored and matched in. Gmail ignores dots and
 * "+tags" in the local part and treats googlemail.com as gmail.com, so
 * "Jane.Doe+cue@googlemail.com" and "janedoe@gmail.com" are one address.
 */
export function normalizeAccessEmail(email: string) {
  const lower = lowercaseEmail(email);
  const at = lower.lastIndexOf("@");
  if (at < 1) return lower;
  if (!GMAIL_DOMAINS.includes(lower.slice(at + 1))) return lower;
  const localPart = lower.slice(0, at).split("+")[0].replaceAll(".", "");
  return `${localPart}@gmail.com`;
}

function lowercaseEmail(email: string) {
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
