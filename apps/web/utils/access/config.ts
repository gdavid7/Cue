// Founder decisions for the private beta, kept in one place so each is a
// one-line change. The gate itself is switched on with AUTH_WAITLIST_ENABLED.

/**
 * How an approved person hears about it.
 * - "manual": the admin page offers the email to copy or open in a mail app.
 * - "founder-mailbox": Cue sends it from the approving admin's own connected
 *   mailbox (one send per approval).
 */
export const ACCESS_APPROVAL_EMAIL_DELIVERY: "manual" | "founder-mailbox" =
  "manual";

/**
 * Mailboxes an approved person may connect besides their own while the
 * waitlist is on. Access is personal, so this keeps one approval from
 * covering a friend's inbox. `null` removes the limit.
 */
export const MAX_EXTRA_MAILBOXES_PER_USER: number | null = 2;
export const MAILBOX_LIMIT_MESSAGE =
  "You've connected as many mailboxes as the beta allows. Cue access is personal, so each person needs their own approval.";
/** The accounts page `error` code for a link refused by that limit. */
export const MAILBOX_LIMIT_ERROR = "mailbox_limit";

/**
 * While the Google OAuth app is in Testing, only addresses listed as test
 * users can finish Google sign-in, so every approval needs a matching entry
 * there too.
 */
export const GOOGLE_OAUTH_TESTING_MODE = true;
export const GOOGLE_OAUTH_TEST_USERS_URL =
  "https://console.cloud.google.com/apis/credentials/consent";

/** Domains that are Gmail; the request form only takes these addresses. */
export const GMAIL_DOMAINS = ["gmail.com", "googlemail.com"];
