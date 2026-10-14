"use client";

import useSWR from "swr";
import type { CueMembershipResponse } from "@/app/api/user/mail-splits/cue-membership/route";

export function cueMembershipKey(emailAccountId: string) {
  return ["/api/user/mail-splits/cue-membership", emailAccountId];
}

/**
 * The messages Cue sorted into its own tabs. Rules sort new mail in the
 * background, so this refreshes on a timer as well as on focus.
 */
export function useCueMembership(emailAccountId: string, enabled: boolean) {
  const { data } = useSWR<CueMembershipResponse>(
    enabled && emailAccountId ? cueMembershipKey(emailAccountId) : null,
    { refreshInterval: 60_000 },
  );
  return data;
}
