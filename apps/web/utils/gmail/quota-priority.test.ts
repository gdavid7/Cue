import { describe, expect, it } from "vitest";
import { runWithAuditContext } from "@/utils/audit/context";
import {
  currentGmailQuotaContext,
  type GmailQuotaPriority,
} from "@/utils/gmail/quota";

// D-086: what a person triggered or is looking at never waits behind sync,
// prefetch or background AI; only the engine and push keep sync; anything
// nobody listed is background.
const PINNED: Record<string, GmailQuotaPriority> = {
  // Opening and reading a thread, and that thread's AI.
  "threads/detail": "interactive",
  "mail/v1/conversation-membership": "interactive",
  "mail/v1/attachment-content": "interactive",
  "user/thread-context": "interactive",
  "user/thread-brief": "interactive",
  "user/suggested-reply": "interactive",
  "user/public-contact-context": "interactive",
  // A typed search and chat.
  "mail/v1/search": "interactive",
  "user/search-answer": "interactive",
  "user/search-intent": "interactive",
  chat: "interactive",
  "chat/stream": "interactive",
  "mcp-server": "interactive",
  // Compose, send and actions.
  "messages/send": "interactive",
  "user/drafts": "interactive",
  "user/drafts/update": "interactive",
  "mail/v1/operations": "interactive",
  "threads/archive": "interactive",
  "user/senders/bulk": "interactive",
  "user/snoozed-threads/create": "interactive",
  "user/senders/unsubscribe": "interactive",
  "user/senders/status": "interactive",
  "v1/senders/unsubscribe": "interactive",
  "user/mail/matching-count": "interactive",
  "user/signature": "interactive",
  "user/scheduled-emails/retry": "interactive",
  messages: "interactive",
  "mobile/all-inboxes/archive": "interactive",
  "chat/confirm-email-action": "interactive",
  // Pages a person opened.
  "user/home": "interactive",
  labels: "interactive",
  "google/linking/callback": "interactive",
  "clean/onboarding": "interactive",
  // The engine and push.
  "mail/v1/changes": "sync",
  "mail/v1/changes-batch": "sync",
  "mail/v1/enumeration": "sync",
  "mail/v1/hydration": "sync",
  "mail/v1/bootstrap": "sync",
  "mail/v1/scopes": "sync",
  "google/webhook": "sync",
  "mobile/mailbox-sync": "sync",
  "snoozed-threads/execute": "sync",
  "scheduled-emails/execute": "sync",
  "auth/link-watch": "sync",
  // Work nobody asked for and can't see yet.
  "user/inbox-insights": "background",
  "user/stats/newsletters": "background",
  "user/thread-plans": "background",
  "mail/v1/assistant-state": "background",
  "cron/automation-jobs": "background",
  "resend/digest": "background",
  "user/cue-labels": "background",
  "user/stats/load": "background",
  "user/categorize/senders/batch": "background",
  "cron/scheduled-actions": "background",
  "clean/gmail": "background",
  // A select-all action runs on capacity nobody is using.
  "mail/bulk-matching": "background",
  // Only shares a prefix with a listed route.
  "user/stats-preview": "background",
  // Better Auth's routes name no scope; what they start after sign-in
  // names its own caller (auth/link-watch).
  "/api/auth/callback/google": "background",
  // The public API's reads serve other people's automation, not a person
  // waiting in Cue, so they only spend what nobody else is using (its
  // unsubscribe, an action, is listed as interactive above).
  "/api/v1/stats/by-period": "background",
  "some/route-nobody-listed": "background",
  "/api/some/unscoped/path": "background",
};

describe("Gmail quota priority by caller", () => {
  it.each(Object.entries(PINNED))("%s runs at %s", (source, priority) => {
    const context = runWithAuditContext({ actorType: "user", source }, () =>
      currentGmailQuotaContext(),
    );
    expect(context.priority).toBe(priority);
  });

  it("treats a caller with no source, as a server component has, as background", () => {
    expect(currentGmailQuotaContext().priority).toBe("background");
  });
});
