"use client";

import { useMemo } from "react";
import useSWR from "swr";
import { mailClientSupports } from "@inboxzero/mail-core/capabilities";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
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
 *
 * `byConversation` says the membership names whole conversations, which the
 * mail engine can match: an engine bundled with an older desktop build can't,
 * so the conversation ids are left out for it and only the messages named are
 * matched.
 */
export function useCueMembership(enabled: boolean): {
  membership: CueMembership | undefined;
  unavailable: boolean;
  byConversation: boolean;
} {
  const { data, error } = useSWR<CueMembershipResponse>(
    enabled ? CUE_MEMBERSHIP_KEY : null,
    { refreshInterval: 60_000 },
  );
  const client = useOptionalMailClient();
  const engineMatchesConversations = mailClientSupports(
    client,
    "predicate:conversation",
  );
  const membership = useMemo((): CueMembership | undefined => {
    if (!data || engineMatchesConversations) return data;
    const { threads: _threads, ...messages } = data;
    return messages;
  }, [data, engineMatchesConversations]);
  if (membership)
    return {
      membership,
      unavailable: false,
      byConversation: Boolean(membership.threads),
    };
  if (error)
    return {
      membership: EMPTY_MEMBERSHIP,
      unavailable: true,
      byConversation: false,
    };
  return { membership: undefined, unavailable: false, byConversation: false };
}
