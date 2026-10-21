import { ErrorType, watchLapsedErrorKey } from "@/utils/error-messages";

export function getWatchStatus(expiresAt: Date | null, now: Date) {
  if (!expiresAt) return "missing";
  return expiresAt <= now ? "expired" : "active";
}

// Stored keys are fixed ErrorType names, except the watch-lapsed key, which
// carries the mailbox id and may belong to the user's other mailbox.
export function getErrorTypes(errorMessages: unknown, emailAccountId: string) {
  if (!errorMessages || typeof errorMessages !== "object") return [];
  const knownTypes = new Set<string>(Object.values(ErrorType));
  return Object.keys(errorMessages).flatMap((key) => {
    if (key === watchLapsedErrorKey(emailAccountId))
      return [ErrorType.EMAIL_WATCH_LAPSED];
    return knownTypes.has(key) ? [key] : [];
  });
}
