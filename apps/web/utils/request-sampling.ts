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

export function getFastRequestSampleRate(scope: string | undefined) {
  return scope && POLLING_SCOPES.has(scope)
    ? POLLING_REQUEST_SAMPLE_RATE
    : FAST_REQUEST_SAMPLE_RATE;
}

export function isFastRequestSampled(samplingId: string, rate: number) {
  const hash = createHash("sha256").update(samplingId).digest().readUInt32BE(0);
  return hash / 2 ** 32 < rate;
}
