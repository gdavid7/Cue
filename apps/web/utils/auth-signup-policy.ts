import { APIError } from "better-auth";
import { env } from "@/env";

const SIGNUP_NOT_ALLOWED_ERROR = {
  message: "signup_not_allowed",
  code: "SIGNUP_NOT_ALLOWED",
} as const;

export function createSignupNotAllowedError() {
  return APIError.from("UNAUTHORIZED", SIGNUP_NOT_ALLOWED_ERROR);
}

/**
 * The env allow-list on its own. Sign-up also admits people approved on
 * /admin/access, so gate new accounts with `assertSignUpAllowed` in
 * utils/access/policy.ts rather than this.
 */
export function isAllowedAuthSignupEmail(
  email: string,
  options: {
    allowedEmails?: readonly string[];
    allowedDomains?: readonly string[];
  } = getAuthSignupPolicy(),
) {
  if (!normalizeEmail(email)) return false;
  if (isAuthSignupOpen(options)) return true;

  return isListedInAuthAllowlist(email, options);
}

/** No allow-list means open sign-up. */
export function isAuthSignupOpen(
  options: {
    allowedEmails?: readonly string[];
    allowedDomains?: readonly string[];
  } = getAuthSignupPolicy(),
) {
  const { allowedEmails, allowedDomains } = normalizeAllowlist(options);
  return allowedEmails.length === 0 && allowedDomains.length === 0;
}

/** Whether the email is named by the allow-lists; empty lists name nobody. */
export function isListedInAuthAllowlist(
  email: string,
  options: {
    allowedEmails?: readonly string[];
    allowedDomains?: readonly string[];
  },
) {
  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) return false;

  const { allowedEmails, allowedDomains } = normalizeAllowlist(options);
  if (allowedEmails.includes(normalizedEmail)) return true;

  const emailDomain = getEmailDomain(normalizedEmail);
  return !!emailDomain && allowedDomains.includes(emailDomain);
}

function getAuthSignupPolicy() {
  return {
    allowedEmails: env.AUTH_ALLOWED_EMAILS,
    allowedDomains: env.AUTH_ALLOWED_EMAIL_DOMAINS,
  };
}

function normalizeAllowlist(options: {
  allowedEmails?: readonly string[];
  allowedDomains?: readonly string[];
}) {
  return {
    allowedEmails: (options.allowedEmails ?? [])
      .map(normalizeEmail)
      .filter(Boolean),
    allowedDomains: (options.allowedDomains ?? [])
      .map(normalizeDomain)
      .filter(Boolean),
  };
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function normalizeDomain(domain: string) {
  return domain.trim().replace(/^@/, "").toLowerCase();
}

function getEmailDomain(email: string) {
  const atIndex = email.lastIndexOf("@");
  if (atIndex === -1) return "";

  return email.slice(atIndex + 1).toLowerCase();
}
