import { z } from "zod";

const darkEmailModeSchema = z.enum(["adapt", "original"]);
export type DarkEmailMode = z.infer<typeof darkEmailModeSchema>;
type SenderModes = Record<string, DarkEmailMode>;

export const DARK_EMAIL_DEFAULT_KEY = "cue.dark-emails.default";
const MAX_REMEMBERED_SENDERS = 500;

export function darkEmailSendersKey(emailAccountId: string) {
  return `cue.dark-emails.senders:${emailAccountId}`;
}

export function parseDarkEmailMode(raw: string | null): DarkEmailMode {
  const parsed = darkEmailModeSchema.safeParse(raw);
  return parsed.success ? parsed.data : "adapt";
}

export function parseSenderModes(raw: string | null): SenderModes {
  if (!raw) return {};
  try {
    const parsed = z
      .record(z.string(), darkEmailModeSchema)
      .safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : {};
  } catch {
    return {};
  }
}

export function resolveDarkEmailMode({
  defaultMode,
  senderModes,
  sender,
}: {
  defaultMode: DarkEmailMode;
  senderModes: SenderModes;
  sender: string | null | undefined;
}): DarkEmailMode {
  if (!sender) return defaultMode;
  return senderModes[normalizeSender(sender)] ?? defaultMode;
}

/**
 * Records a sender's choice. One that matches the default is dropped, so the
 * sender follows the default again if it later changes, and only the most
 * recent choices are kept.
 */
export function rememberSenderDarkEmailMode(
  senderModes: SenderModes,
  {
    sender,
    mode,
    defaultMode,
  }: { sender: string; mode: DarkEmailMode; defaultMode: DarkEmailMode },
): SenderModes {
  const key = normalizeSender(sender);
  const { [key]: _previous, ...others } = senderModes;
  if (mode === defaultMode) return others;

  const entries = Object.entries(others);
  return Object.fromEntries([
    ...entries.slice(
      Math.max(0, entries.length - (MAX_REMEMBERED_SENDERS - 1)),
    ),
    [key, mode],
  ]);
}

function normalizeSender(sender: string) {
  return sender.trim().toLowerCase();
}
