import { prefixPath } from "@/utils/path";

/**
 * The provider ended Cue's sign-in (for Google, usually the weekly refresh
 * token expiry while the OAuth app is in Testing). The consent page then
 * offers a plain "Sign in again" instead of a list of missing permissions.
 */
export const CONSENT_REASON_EXPIRED = "expired";

export function getPermissionsConsentPath(
  emailAccountId: string,
  { expired }: { expired: boolean },
) {
  const path = prefixPath(emailAccountId, "/permissions/consent");
  return expired ? `${path}?reason=${CONSENT_REASON_EXPIRED}` : path;
}
