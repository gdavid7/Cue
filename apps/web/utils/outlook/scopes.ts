// https://learn.microsoft.com/en-us/graph/permissions-reference

import { env } from "@/env";

export const REQUIRED_SCOPES = [
  "openid",
  "profile",
  "email",
  "User.Read",
  "offline_access", // Required for refresh tokens
  "Mail.ReadWrite", // Read and write access to mailbox
  ...(env.NEXT_PUBLIC_EMAIL_SEND_ENABLED ? ["Mail.Send"] : []), // Send emails
  "MailboxSettings.ReadWrite", // Read and write mailbox settings
] as const;

// Asked for at sign-in, so a new account's calendar connects with its mailbox.
// Optional: accounts consented before then keep working without them, and the
// Calendars page can still connect a calendar separately.
const CALENDAR_ACCESS_SCOPES = [
  "Calendars.Read", // Read user calendars
  "Calendars.ReadWrite", // Read and write user calendars
] as const;

export const SCOPES = [
  ...REQUIRED_SCOPES,
  ...CALENDAR_ACCESS_SCOPES,
  // Contacts.Read reads the saved-contacts folder; People.Read adds the
  // directory and recent correspondents. Both are optional, and accounts
  // consented before either was requested keep working with whichever they hold.
  ...(env.NEXT_PUBLIC_CONTACTS_ENABLED ? ["Contacts.Read", "People.Read"] : []),
] as const;

export const CALENDAR_SCOPES = [
  "openid",
  "profile",
  "email",
  "User.Read",
  "offline_access", // Required for refresh tokens
  ...CALENDAR_ACCESS_SCOPES,
] as const;
