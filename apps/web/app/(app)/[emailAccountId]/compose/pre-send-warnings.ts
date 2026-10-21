import { extractEmailAddresses } from "@/utils/email";
import { findEscapedMarkup } from "@/utils/email/escaped-markup";
import { findPlaceholders } from "./find-placeholders";

export const LARGE_REPLY_RECIPIENT_COUNT = 10;
const MAX_PLACEHOLDERS_SHOWN = 3;

export type PreSendDraft = {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** The text the user wrote, without the quoted message or signature. */
  bodyText: string;
  /** `bodyText` without code, which can hold placeholders on purpose. */
  bodyTextWithoutCode: string;
  /** Files, inline images and files the message carries from elsewhere. */
  attachmentCount: number;
};

export type PreSendContext = {
  kind: "new" | "reply" | "forward";
  /** Everyone on the message being replied to. */
  repliedToAddresses: string[];
  /** Recipients the user set up ahead, such as a rule's own; never new. */
  chosenAddresses?: string[];
  ownEmails: string[];
};

export type PreSendWarningFix = "attach" | "subject" | "recipients" | "body";

export type PreSendWarning = {
  id:
    | "missing-attachment"
    | "no-subject"
    | "large-reply"
    | "new-recipients"
    | "escaped-markup"
    | "placeholders";
  message: string;
  fix: PreSendWarningFix;
  /** Text in the message the fix should select. */
  selectText?: string;
};

/**
 * Common slips worth a second look before a send goes out. Runs on the local
 * draft only, synchronously, so a clean send pays nothing for it.
 */
export function getPreSendWarnings(
  draft: PreSendDraft,
  context: PreSendContext,
): PreSendWarning[] {
  const warnings: PreSendWarning[] = [];

  if (draft.attachmentCount === 0 && mentionsAttachment(draft.bodyText)) {
    warnings.push({
      id: "missing-attachment",
      message: "The message mentions an attachment, but nothing is attached.",
      fix: "attach",
    });
  }

  if (context.kind === "new" && !draft.subject.trim()) {
    warnings.push({
      id: "no-subject",
      message: "This message has no subject.",
      fix: "subject",
    });
  }

  if (context.kind === "reply") {
    const own = new Set(uniqueAddresses(context.ownEmails));
    const recipients = uniqueAddresses([draft.to, draft.cc, draft.bcc]).filter(
      (address) => !own.has(address),
    );
    if (recipients.length >= LARGE_REPLY_RECIPIENT_COUNT) {
      warnings.push({
        id: "large-reply",
        message: `This reply goes to ${recipients.length} people.`,
        fix: "recipients",
      });
    }
    const known = new Set(
      uniqueAddresses([
        ...context.repliedToAddresses,
        ...(context.chosenAddresses ?? []),
      ]),
    );
    const added = recipients.filter((address) => !known.has(address));
    if (added.length) {
      warnings.push({
        id: "new-recipients",
        message: describeNewRecipients(added),
        fix: "recipients",
      });
    }
  }

  const leaks = findEscapedMarkup(draft.bodyText);
  if (leaks.length) {
    warnings.push({
      id: "escaped-markup",
      message: `The message shows raw HTML code: ${leaks.join(", ")}.`,
      fix: "body",
    });
  }

  const placeholders = findPlaceholders(draft.bodyTextWithoutCode);
  if (placeholders.length) {
    warnings.push({
      id: "placeholders",
      message: describePlaceholders(placeholders),
      fix: "body",
      selectText: placeholders[0],
    });
  }

  return warnings;
}

/**
 * Words people write when they mean to attach something, in a few major
 * languages. A deterministic hint, so it stays short: only phrases that rarely
 * mean anything else in an email.
 */
export const ATTACHMENT_PHRASES = [
  // English
  "attached",
  "attachment",
  "attachments",
  "enclosed",
  // Spanish
  "adjunto",
  "adjunta",
  "adjuntos",
  "adjuntas",
  // French
  "ci-joint",
  "ci-jointe",
  "ci-joints",
  "pièce jointe",
  "pièces jointes",
  // German
  "anbei",
  "im anhang",
  "angehängt",
  // Portuguese
  "em anexo",
  "anexado",
  "anexada",
  "anexei",
  // Italian
  "in allegato",
  "allegato",
  "allegata",
  // Dutch
  "bijgevoegd",
  "in de bijlage",
];

const ATTACHMENT_PATTERN = new RegExp(
  `(?<![\\p{L}\\p{N}])(?:${ATTACHMENT_PHRASES.map(escapeRegExp)
    .map((phrase) => phrase.replace(/ /g, "\\s+"))
    .join("|")})(?![\\p{L}\\p{N}])`,
  "iu",
);

export function mentionsAttachment(text: string) {
  return ATTACHMENT_PATTERN.test(text.normalize("NFC"));
}

/**
 * The text the user wrote in the editor, leaving out a forwarded or quoted
 * message, which can mention attachments the user never meant to send.
 */
export function getComposeBodyText(html: string, { withoutCode = false } = {}) {
  const document = new DOMParser().parseFromString(html, "text/html");
  if (withoutCode)
    for (const code of document.body.querySelectorAll("pre, code"))
      code.remove();
  for (const quoted of document.body.querySelectorAll(
    "blockquote, .gmail_quote",
  ))
    quoted.remove();
  // textContent runs blocks together ("Hi BobAttached"), which hides words.
  for (const lineBreak of document.body.querySelectorAll("br"))
    lineBreak.replaceWith("\n");
  for (const block of document.body.querySelectorAll(TEXT_BLOCKS))
    block.append("\n");
  return (document.body.textContent ?? "").trim();
}

const TEXT_BLOCKS = "p, div, li, h1, h2, h3, h4, h5, h6, tr";

function uniqueAddresses(lists: (string | undefined)[]) {
  return [
    ...new Set(
      lists.flatMap((list) =>
        extractEmailAddresses(list ?? "").map((address) =>
          address.toLowerCase(),
        ),
      ),
    ),
  ];
}

function describePlaceholders(placeholders: string[]) {
  const shown = placeholders.slice(0, MAX_PLACEHOLDERS_SHOWN).join(", ");
  const more = placeholders.length - MAX_PLACEHOLDERS_SHOWN;
  if (more > 0)
    return `The message still has placeholders to fill in: ${shown} and ${more} more.`;
  const noun = placeholders.length === 1 ? "a placeholder" : "placeholders";
  return `The message still has ${noun} to fill in: ${shown}.`;
}

function describeNewRecipients(added: string[]) {
  const [first, ...rest] = added;
  if (!rest.length) return `${first} wasn't on the message you're replying to.`;
  const others = rest.length === 1 ? "1 other" : `${rest.length} others`;
  return `${first} and ${others} weren't on the message you're replying to.`;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
