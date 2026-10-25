import {
  MAIL_QUERY_FEATURES,
  type MailEngineCapabilities,
} from "@inboxzero/mail-core/capabilities";

/**
 * What this build's engine answers over IPC, handed to the page through the
 * preload bridge so it is known before the first query. Only optional
 * methods the IPC dispatcher routes belong here; ipc.test.ts holds the list
 * to the IPC schema.
 */
export const DESKTOP_MAIL_ENGINE_CAPABILITIES: MailEngineCapabilities = [
  ...MAIL_QUERY_FEATURES,
  "method:observeMailboxWindow",
  "method:forgetDeletedDrafts",
  "method:getWaitingSummary",
  "method:queryImportantPeople",
  "method:setImportantPerson",
];
