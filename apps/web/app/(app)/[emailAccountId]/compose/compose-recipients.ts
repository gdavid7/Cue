import {
  extractEmailAddress,
  isValidEmail,
  splitRecipientList,
} from "@/utils/email";
import { mergeAndDedupeRecipients } from "@/utils/email/reply-all";

export type ComposeRecipientField = "to" | "cc" | "bcc";

export function resolveComposeRecipientFields({
  selectedRecipients,
  pendingRecipients,
}: {
  selectedRecipients: Record<ComposeRecipientField, string | undefined>;
  pendingRecipients: Record<ComposeRecipientField, string>;
}) {
  const resolveField = (field: ComposeRecipientField) =>
    resolveComposeRecipients({
      selectedRecipients: selectedRecipients[field],
      pendingRecipient: pendingRecipients[field],
    });

  return {
    to: resolveField("to"),
    cc: resolveField("cc") || undefined,
    bcc: resolveField("bcc") || undefined,
  };
}

// Returns null when the change should be ignored (e.g. the pending search
// query is not a valid email yet). An empty array means the sole recipient
// was deselected, so it resolves to an empty selection rather than a no-op.
export function resolveRecipientSelection(values: string[]): string | null {
  if (values.length === 0) return "";
  const lastValue = values.at(-1);
  if (!lastValue || !isValidEmail(extractEmailAddress(lastValue))) return null;
  return values.join(",");
}

export function resolveComposeRecipients({
  selectedRecipients,
  pendingRecipient,
}: {
  selectedRecipients: string | undefined;
  pendingRecipient: string;
}) {
  const selected = splitRecipientList(selectedRecipients ?? "");
  const pending = pendingRecipient.trim();

  if (!isValidComposeRecipientList(pending)) return selected.join(",");

  return mergeAndDedupeRecipients(selected, pending).join(",");
}

export function isValidComposeRecipientList(value: string) {
  const recipients = splitRecipientList(value);
  return (
    recipients.length > 0 &&
    recipients.every((recipient) =>
      isValidEmail(extractEmailAddress(recipient)),
    )
  );
}

/**
 * The first field whose typed, uncommitted text isn't a valid address list.
 * Sending would otherwise drop that text without a word.
 */
export function findInvalidPendingRecipientField(
  pendingRecipients: Record<ComposeRecipientField, string>,
): ComposeRecipientField | null {
  for (const field of ["to", "cc", "bcc"] as const) {
    const pending = pendingRecipients[field].trim();
    if (pending && !isValidComposeRecipientList(pending)) return field;
  }
  return null;
}

/**
 * Pasted lists come separated by commas, semicolons (Outlook) or lines
 * (spreadsheets). Separators inside a quoted display name are kept.
 */
export function normalizePastedRecipients(text: string) {
  const recipients: string[] = [];
  let current = "";
  let inQuotes = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (inQuotes && char === "\\") {
      current += char + (text[index + 1] ?? "");
      index++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
      current += char;
    } else if (!inQuotes && /[,;\r\n]/.test(char)) {
      if (current.trim()) recipients.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim()) recipients.push(current.trim());
  return recipients.join(", ");
}
