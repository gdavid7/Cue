import type Mail from "nodemailer/lib/mailer";
import {
  buildCueDemoCalendarEvents,
  buildCueDemoInbox,
} from "@/__tests__/fixtures/inboxes/cue-demo-inbox";
import type { DemoInboxAddress } from "@/__tests__/fixtures/inboxes/types";

// The QA inbox's seed mail, built from the Cue demo fixture. Every address
// other than the QA account's own is rewritten to the reserved example.com
// domain, so nothing the app or the robot does with it can reach a person.

type SeedMessage = {
  key: string;
  messageId: string;
  folder: "inbox" | "sent" | "archive";
  unread: boolean;
  date: Date;
  mail: Mail.Options;
};

const SEED_DOMAIN = "example.com";

export function buildSeedMessages({
  email,
  now = new Date(),
}: {
  email: string;
  now?: Date;
}): SeedMessage[] {
  const fixture = buildCueDemoInbox(now);
  const owner = fixture.mailbox.email.toLowerCase();
  const address = (person: DemoInboxAddress) => ({
    name: person.name ?? "",
    address: rewriteAddress(person.email, { owner, email }),
  });

  const messages: SeedMessage[] = [];
  for (const thread of fixture.threads) {
    const references: string[] = [];
    for (const message of thread.messages) {
      const messageId = seedMessageId(message.id);
      const labels = message.labels ?? [];
      messages.push({
        key: message.id,
        messageId,
        folder: labels.includes("SENT")
          ? "sent"
          : labels.includes("INBOX")
            ? "inbox"
            : "archive",
        unread: message.unread === true,
        date: new Date(message.date),
        mail: {
          from: address(message.from),
          to: message.to.map(address),
          ...(message.cc ? { cc: message.cc.map(address) } : {}),
          subject: message.subject,
          text: message.bodyText,
          ...(message.bodyHtml ? { html: message.bodyHtml } : {}),
          ...threading(references),
        },
      });
      references.push(messageId);
    }
  }

  messages.push(buildInvite({ email, owner, now }));
  messages.push(...buildLongThread({ email, now }));
  return messages;
}

function rewriteAddress(
  value: string,
  { owner, email }: { owner: string; email: string },
) {
  const normalized = value.trim().toLowerCase();
  if (normalized === owner) return email;
  const [local, domain = ""] = normalized.split("@");
  const tag = domain.split(".")[0];
  return `${local}${tag ? `.${tag}` : ""}@${SEED_DOMAIN}`;
}

function buildInvite({
  email,
  owner,
  now,
}: {
  email: string;
  owner: string;
  now: Date;
}): SeedMessage {
  const [event] = buildCueDemoCalendarEvents(owner, now);
  const organizer = event.attendees.find(
    (attendee) => attendee.email !== owner,
  );
  const organizerEmail = rewriteAddress(organizer?.email ?? "organizer", {
    owner,
    email,
  });
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Cue//QA seed//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    `UID:${event.id}@cue-qa.invalid`,
    `DTSTAMP:${toIcsUtc(now)}`,
    `SUMMARY:${event.summary}`,
    ...(event.location ? [`LOCATION:${event.location}`] : []),
    `DTSTART:${toIcsUtc(new Date(event.start_date_time))}`,
    `DTEND:${toIcsUtc(new Date(event.end_date_time))}`,
    `ORGANIZER;CN=${organizer?.display_name ?? "Organizer"}:mailto:${organizerEmail}`,
    `ATTENDEE;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${email}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  return {
    key: event.id,
    messageId: seedMessageId(event.id),
    folder: "inbox",
    unread: true,
    date: new Date(now.getTime() - 60 * 60_000),
    mail: {
      from: { name: organizer?.display_name ?? "", address: organizerEmail },
      to: email,
      subject: `Invitation: ${event.summary}`,
      text: `You have been invited to ${event.summary}${event.location ? ` at ${event.location}` : ""}.`,
      icalEvent: { method: "REQUEST", filename: "invite.ics", content: ics },
    },
  };
}

function buildLongThread({
  email,
  now,
}: {
  email: string;
  now: Date;
}): SeedMessage[] {
  const teammate = { name: "Kevin Ruiz", address: `kruiz.ucsd@${SEED_DOMAIN}` };
  const turns: { fromSelf: boolean; text: string }[] = [
    {
      fromSelf: false,
      text: "Started the evaluation section. Should we report accuracy and F1, or just F1?",
    },
    {
      fromSelf: true,
      text: "Both, with F1 as the headline number. Can you add the confusion matrix too?",
    },
    {
      fromSelf: false,
      text: "Added. The validation split looks off though, the class balance differs a lot from train.",
    },
    {
      fromSelf: true,
      text: "Good catch. Let's switch to a stratified split and rerun tonight.",
    },
    {
      fromSelf: false,
      text: "Rerun done. F1 went from 0.71 to 0.78. Plots are in the shared folder.",
    },
    {
      fromSelf: true,
      text: "Great. I'll write it up tomorrow morning and send a draft by noon.",
    },
    {
      fromSelf: false,
      text: "Sounds good. Can you also mention the stratification change in the methods section?",
    },
  ];
  const subject = "CSE 151B project: evaluation plan";
  const references: string[] = [];
  return turns.map((turn, index) => {
    const key = `cue-qa-long-thread-${index + 1}`;
    const messageId = seedMessageId(key);
    const self = { name: "", address: email };
    const message: SeedMessage = {
      key,
      messageId,
      folder: turn.fromSelf ? "sent" : "inbox",
      unread: !turn.fromSelf && index === turns.length - 1,
      date: new Date(now.getTime() - (turns.length - index) * 3 * 3_600_000),
      mail: {
        from: turn.fromSelf ? self : teammate,
        to: turn.fromSelf ? teammate : self,
        subject: index === 0 ? subject : `Re: ${subject}`,
        text: turn.text,
        ...threading(references),
      },
    };
    references.push(messageId);
    return message;
  });
}

function threading(references: string[]) {
  if (references.length === 0) return {};
  return { inReplyTo: references.at(-1), references: [...references] };
}

function seedMessageId(key: string) {
  return `<cue-qa-seed-${key}@cue-qa.invalid>`;
}

function toIcsUtc(value: Date) {
  return value
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}
