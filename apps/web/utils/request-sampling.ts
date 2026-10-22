import { createHash } from "node:crypto";

// Share of fast, successful requests logged so latency percentiles can be
// computed from Axiom. Lines carry sampleRate so counts can be re-weighted.
const FAST_REQUEST_SAMPLE_RATE = 0.08;
// Background polls and streams fire constantly per open tab, so they sample
// lower to keep their share of the volume small.
const POLLING_REQUEST_SAMPLE_RATE = 0.015;
const POLLING_SCOPES = new Set([
  "mail-stream",
  "mail-version",
  "email-stream",
  "team-comments/stream",
  "health",
  "voice/status",
  "user/digest-status",
  "user/ai-automation-status",
  "mobile-review/status",
  "mail/v1/enumeration",
  "user/sent-message-opens",
  "user/mail-splits/cue-membership",
  "user/scheduled-emails",
]);

// The AI routes a person waits on while reading, sampled higher so their
// latency and gate waits can be measured from more than the slow tail
// (PF-9w). Each is paced by a person (a thread opened, a search typed) or by
// the rows' 15 s spacing, but at this rate they add an estimated three to
// five times the polling scopes' lines. Temporary, for the PF-9w measurement:
// PF-9x brings it back down once that is read.
const READER_AI_REQUEST_SAMPLE_RATE = 0.5;
const READER_AI_SCOPES = new Set([
  "user/inbox-insights",
  "user/thread-brief",
  "user/thread-context",
  "user/search-answer",
]);

export function getFastRequestSampleRate(scope: string | undefined) {
  if (!scope) return FAST_REQUEST_SAMPLE_RATE;
  if (POLLING_SCOPES.has(scope)) return POLLING_REQUEST_SAMPLE_RATE;
  if (READER_AI_SCOPES.has(scope)) return READER_AI_REQUEST_SAMPLE_RATE;
  return FAST_REQUEST_SAMPLE_RATE;
}

export function isFastRequestSampled(samplingId: string, rate: number) {
  const hash = createHash("sha256").update(samplingId).digest().readUInt32BE(0);
  return hash / 2 ** 32 < rate;
}
