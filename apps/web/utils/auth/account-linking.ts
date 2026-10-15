import { isGoogleAuthoritativeEmail } from "@/utils/access/policy";

/**
 * Social sign-in links to an existing user with the same email when the
 * provider is trusted or reports the email verified. A trusted provider skips
 * that check, so Google is not trusted: its verified flag is accurate (see
 * getGoogleUserFields), and an unverified Google claim must not take over the
 * account of whoever owns that address.
 */
export const ACCOUNT_LINKING = {
  enabled: true,
  trustedProviders: ["apple"],
};

/** Google's verified flag, narrowed to addresses Google is authoritative for. */
export function getGoogleUserFields(profile: {
  email?: string;
  email_verified?: boolean;
  hd?: string;
}) {
  return {
    emailVerified: isGoogleAuthoritativeEmail({
      email: profile.email,
      emailVerified: profile.email_verified,
      hostedDomain: profile.hd,
    }),
  };
}

/**
 * Entra lets a tenant set a user's email claim, so Microsoft never counts as
 * verifying an address: it can't link to an existing user by email or use an
 * approval or allow-list entry.
 */
export function getMicrosoftUserFields() {
  return { emailVerified: false };
}
