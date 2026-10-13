// Step 1 of the pipeline: ingestion + normalization.
// Provider-specific objects in, shared event model out.

import type { CalendarEvent, Doc, Identity, Message, Provenance } from "../core/types.ts";
import type { GcalRaw, GdriveRaw, GmailRaw, OutlookRaw } from "./fixtures.ts";

/** Parse an RFC 5322 address like `Dana Kim <dana@x.org>` or a bare `dana@x.org`. */
export function parseAddress(raw: string): Identity {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1].trim() || undefined, email: m[2].trim().toLowerCase() };
  return { email: raw.trim().toLowerCase() };
}

export function fromGmail(raw: GmailRaw, accountId: string): Message {
  const header = (name: string) => raw.payload.headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? "";
  const source: Provenance = { provider: "gmail", sourceId: raw.id, accountId };
  return {
    id: `msg_${raw.id}`,
    threadId: `thr_${raw.threadId}`,
    from: parseAddress(header("From")),
    to: header("To").split(",").filter(Boolean).map(parseAddress),
    subject: header("Subject"),
    body: Buffer.from(raw.payload.body.data, "base64url").toString("utf8"),
    sentAt: new Date(Number(raw.internalDate)).toISOString(),
    attachments: raw.attachments ?? [],
    source,
  };
}

export function fromOutlook(raw: OutlookRaw, accountId: string): Message {
  const id = (a: { emailAddress: { name: string; address: string } }): Identity => ({
    name: a.emailAddress.name || undefined,
    email: a.emailAddress.address.toLowerCase(),
  });
  return {
    id: `msg_${raw.id}`,
    threadId: `thr_${raw.conversationId}`,
    from: id(raw.from),
    to: raw.toRecipients.map(id),
    subject: raw.subject,
    body: raw.body.content,
    sentAt: new Date(raw.receivedDateTime).toISOString(),
    attachments: [],
    source: { provider: "outlook", sourceId: raw.id, accountId },
  };
}

export function fromGcal(raw: GcalRaw, accountId: string): CalendarEvent {
  return {
    id: `evt_${raw.id}`,
    title: raw.summary,
    start: new Date(raw.start.dateTime).toISOString(),
    end: new Date(raw.end.dateTime).toISOString(),
    location: raw.location,
    notes: raw.description,
    attendees: (raw.attendees ?? []).map((a) => ({ name: a.displayName, email: a.email.toLowerCase() })),
    source: { provider: "gcal", sourceId: raw.id, accountId },
  };
}

export function fromGdrive(raw: GdriveRaw, accountId: string): Doc {
  const owner = raw.owners[0];
  return {
    id: `doc_${raw.id}`,
    title: raw.name,
    mimeType: raw.mimeType,
    modifiedAt: new Date(raw.modifiedTime).toISOString(),
    owner: { name: owner.displayName, email: owner.emailAddress.toLowerCase() },
    sharedWith: (raw.permissions ?? []).map((p) => ({ name: p.displayName, email: p.emailAddress.toLowerCase() })),
    text: raw.exportedText,
    source: { provider: "gdrive", sourceId: raw.id, accountId },
  };
}
