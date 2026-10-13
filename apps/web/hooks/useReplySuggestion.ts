import { useSuggestedReply } from "@/hooks/useSuggestedReply";

/**
 * When mail and calendar can't back a reply, look on the web before giving
 * up. Off until the web query is privacy-reviewed.
 */
export const AUTO_WEB_LOOKUP = false;

/**
 * A reply Cue backs with sources, and where it is in getting one: first the
 * user's own mail and calendar, then, if those fall short, the web.
 */
export function useReplySuggestion({
  threadId,
  emailAccountId,
  enabled,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  enabled: boolean;
}) {
  const plain = useSuggestedReply({ threadId, emailAccountId, enabled });
  const needsWeb = Boolean(
    AUTO_WEB_LOOKUP &&
      plain.data?.canSearchWeb &&
      plain.data.suggestion.status === "insufficient",
  );
  const web = useSuggestedReply({
    threadId,
    emailAccountId,
    enabled: enabled && needsWeb,
    searchWeb: true,
  });
  // A failed web pass leaves the answer from mail and calendar standing.
  const result = needsWeb && !web.error ? web : plain;

  let phase: "idle" | "checking-mail" | "checking-web" | "done" = "done";
  if (!enabled) phase = "idle";
  else if (plain.isLoading) phase = "checking-mail";
  else if (needsWeb && web.isLoading) phase = "checking-web";

  return {
    phase,
    suggestion: phase === "done" ? result.data?.suggestion : undefined,
    error: result.error,
  };
}
