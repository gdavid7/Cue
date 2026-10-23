import { MAIL_ENGINE_REVISION_HEADER } from "@inboxzero/mail-core/protocol/mail-http";

// Tabs can keep running an engine built before a deploy for hours, and an
// engine from before the enumeration pacing hint (OP-3f-1) asks for every
// backfill page at once. Below this revision the server paces that engine's
// background enumeration itself. Raise it together with MAIL_ENGINE_REVISION
// only when older engines misbehave against the current server.
export const MIN_MAIL_ENGINE_REVISION = 1;

// Long enough that an old tab's backfill all but stops until it reloads, while
// what a person does in it (opening mail, search, commands) is never refused.
export const OLD_ENGINE_RETRY_AFTER_MS = 10 * 60_000;

export type OldEngineReason = "missing_revision" | "below_minimum";

/**
 * Why this request's engine is older than the server's minimum, or null when
 * it is current. Desktop builds from before the header exist and update on
 * their own schedule, so a request with no revision from outside a browser
 * (the desktop engine's Node fetch sends no browser user agent) counts as
 * current; every browser sends a `Mozilla/` user agent.
 */
export function oldEngineReason(headers: Headers): OldEngineReason | null {
  const raw = headers.get(MAIL_ENGINE_REVISION_HEADER);
  if (raw === null) {
    const userAgent = headers.get("user-agent") ?? "";
    return userAgent.startsWith("Mozilla/") ? "missing_revision" : null;
  }
  const revision = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < MIN_MAIL_ENGINE_REVISION)
    return "below_minimum";
  return null;
}
