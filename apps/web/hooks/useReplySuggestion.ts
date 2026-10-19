import { useSuggestedReply } from "@/hooks/useSuggestedReply";

/**
 * When mail and calendar can't back a reply, look on the web before giving
 * up. The search sends only a query the model wrote from public words.
 */
export const AUTO_WEB_LOOKUP = true;

/**
 * A reply Cue backs with sources, and where it is in getting one: first the
 * user's own mail and calendar, then, if those fall short, the web.
 */
export function useReplySuggestion({
  threadId,
  emailAccountId,
  messageId,
  enabled,
}: {
  threadId: string | null | undefined;
  emailAccountId?: string | null;
  /** The newest message shown, which keys what this browser keeps. */
  messageId?: string;
  enabled: boolean;
}) {
  const plain = useSuggestedReply({
    threadId,
    emailAccountId,
    messageId,
    enabled,
  });
  const abstention =
    plain.data?.suggestion?.status === "insufficient"
      ? plain.data.suggestion
      : undefined;
  const needsWeb = Boolean(
    AUTO_WEB_LOOKUP && plain.data?.canSearchWeb && abstention,
  );
  const web = useSuggestedReply({
    threadId,
    emailAccountId,
    messageId,
    enabled: enabled && needsWeb,
    searchWeb: true,
    // The abstention's own query, so the web pass skips the plain answer.
    webQuery: abstention?.webQuery || undefined,
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
