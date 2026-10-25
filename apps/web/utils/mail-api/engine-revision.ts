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

export type OldEngineReason = "below_minimum";

/**
 * Why this request's engine is older than the server's minimum, or null when
 * it is current. A revision that is present but low or not a number is old.
 *
 * A request with no revision counts as current for now: no engine built
 * before the header sends one, including the ones that already follow the
 * pacing hint, and desktop builds update on their own schedule. Once every
 * engine has sent the header for a release, raising the minimum above 1
 * should make a missing revision count as old too (from browsers; desktop
 * builds send the header from this release on).
 */
export function oldEngineReason(headers: Headers): OldEngineReason | null {
  const raw = headers.get(MAIL_ENGINE_REVISION_HEADER);
  if (raw === null) return null;
  const revision = /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : Number.NaN;
  if (!Number.isSafeInteger(revision) || revision < MIN_MAIL_ENGINE_REVISION)
    return "below_minimum";
  return null;
}
