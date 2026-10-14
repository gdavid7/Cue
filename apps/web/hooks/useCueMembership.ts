"use client";

import useSWR from "swr";
import type { CueMembershipResponse } from "@/app/api/user/mail-splits/cue-membership/route";
import type { CueMembership } from "@/utils/split-inbox/cue-filter";

// A plain key: the account travels in the request header, which is what lets
// the last membership persist for offline use alongside the mail settings.
export const CUE_MEMBERSHIP_KEY = "/api/user/mail-splits/cue-membership";

const EMPTY_MEMBERSHIP: CueMembership = {
  TO_REPLY: [],
  NEWSLETTER: [],
  MARKETING: [],
};

/**
 * The messages Cue sorted into its own tabs, for the current account. Rules
 * sort new mail in the background, so this refreshes on a timer as well as on
 * focus. When it can't load (offline with nothing saved, or a failing request)
 * it reports `unavailable` with empty membership, so lists and counts still
 * render instead of waiting forever.
 */
export function useCueMembership(enabled: boolean): {
  membership: CueMembership | undefined;
  unavailable: boolean;
} {
  const { data, error } = useSWR<CueMembershipResponse>(
    enabled ? CUE_MEMBERSHIP_KEY : null,
    { refreshInterval: 60_000 },
  );
  if (data) return { membership: data, unavailable: false };
  if (error) return { membership: EMPTY_MEMBERSHIP, unavailable: true };
  return { membership: undefined, unavailable: false };
}
