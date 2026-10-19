import type { JSONValue } from "ai";

// Each searchInbox result is re-sent on every later step and turn, so the
// model gets it without what only the UI's email cards use (the link to open
// the email, and an attachment flag that is false for most messages). The
// tool's own output, which the cards render, keeps every field.
export function toSearchInboxModelValue(value: JSONValue): JSONValue {
  if (!isJsonObject(value) || !Array.isArray(value.messages)) return value;

  return { ...value, messages: value.messages.map(toModelMessage) };
}

function toModelMessage(message: JSONValue): JSONValue {
  if (!isJsonObject(message)) return message;

  const { externalUrl: _externalUrl, hasAttachments, ...rest } = message;
  return hasAttachments ? { ...rest, hasAttachments } : rest;
}

function isJsonObject(
  value: JSONValue | undefined,
): value is { [key: string]: JSONValue } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
