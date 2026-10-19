/** What the server pushes for a new message: sender and subject, never the body. */
export type NewMailPushPayload = {
  title: string;
  body: string;
  tag: string;
  /** A same-origin path to the thread. */
  url: string;
  icon?: string;
};

export function parseNewMailPushPayload(
  value: unknown,
): NewMailPushPayload | null {
  if (!value || typeof value !== "object") return null;
  const { title, body, tag, url, icon } = value as Record<string, unknown>;
  if (
    typeof title !== "string" ||
    typeof body !== "string" ||
    typeof tag !== "string" ||
    typeof url !== "string"
  )
    return null;
  return {
    title,
    body,
    tag,
    url,
    ...(typeof icon === "string" ? { icon } : {}),
  };
}

/** The thread's legacy address, which the app resolves to the account's mail view. */
export function newMailThreadPath(emailAccountId: string, threadId: string) {
  return `/${encodeURIComponent(emailAccountId)}/mail?thread-id=${encodeURIComponent(threadId)}`;
}
