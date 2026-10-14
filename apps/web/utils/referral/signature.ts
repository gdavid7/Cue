import { BRAND_NAME } from "@/utils/branding";

const REFERRAL_SIGNATURE_PREFIX = "Drafted by";
// Drafts written before the rename still carry the old name, and must still be
// recognized so they can be stripped and compared against what was sent.
const LEGACY_REFERRAL_SIGNATURE_PRODUCT = "Inbox Zero";

const REFERRAL_SIGNATURE_PATTERNS = [
  ...new Set([BRAND_NAME, LEGACY_REFERRAL_SIGNATURE_PRODUCT]),
].map((product) => createSignaturePatterns(REFERRAL_SIGNATURE_PREFIX, product));
const SENT_WITH_SIGNATURE_PATTERN = createSignaturePatterns(
  "Sent with",
  BRAND_NAME,
);

export function stripBrandingSignatures(value: string) {
  return stripReferralSignature(value)
    .replace(getSignaturePattern(value, SENT_WITH_SIGNATURE_PATTERN), "")
    .trim();
}

export function renderReferralSignatureHtml(referralLink: string) {
  return `${REFERRAL_SIGNATURE_PREFIX} <a href="${referralLink}">${BRAND_NAME}</a>.`;
}

export function hasReferralSignature(value: string) {
  return REFERRAL_SIGNATURE_PATTERNS.some(
    (patterns) => value.search(getSignaturePattern(value, patterns)) !== -1,
  );
}

export function stripReferralSignature(value: string) {
  return REFERRAL_SIGNATURE_PATTERNS.reduce(
    (stripped, patterns) =>
      stripped.replace(getSignaturePattern(stripped, patterns), ""),
    value,
  ).trim();
}

function getSignaturePattern(
  value: string,
  patterns: { text: RegExp; html: RegExp },
) {
  return /<\/?(?:html|body|div|p|br|span|a)(?:\s[^<>]*|\/?)>/i.test(value)
    ? patterns.html
    : patterns.text;
}

function createSignaturePatterns(prefix: string, product: string) {
  const signature = `${escapeRegExp(prefix)}\\s+(?:<a\\b[^<>]*>)?${escapeRegExp(product)}(?:</a>)?(?:\\s*\\[https?://[^\\]\\s]+\\])?\\.?`;
  return {
    text: new RegExp(
      `(?<=^|[\\r\\n])[^\\S\\r\\n]*${signature}(?=[^\\S\\r\\n]*(?:$|[\\r\\n]))`,
      "gi",
    ),
    html: new RegExp(
      `(?<=^|[\\r\\n>])[^\\S\\r\\n]*${signature}(?=[^\\S\\r\\n]*(?:$|[\\r\\n<]))`,
      "gi",
    ),
  };
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
