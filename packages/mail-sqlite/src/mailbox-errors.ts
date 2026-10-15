// Kept apart from the recovery module, which brings the whole store with it,
// so a page that only needs to tell these failures apart stays small.

/**
 * Why a mailbox could not be opened: `busy` clears once another holder lets
 * go of the files, `corrupt` needs a rebuild, `unavailable` means storage
 * cannot hold the mailbox right now (no OPFS, a full disk, an I/O error).
 */
export type MailboxOpenFailure = "corrupt" | "busy" | "unavailable";

export class MailboxCorruptError extends Error {
  constructor(message: string) {
    super(`SQLITE_CORRUPT: ${message}`);
    this.name = "MailboxCorruptError";
  }
}

const MAILBOX_UNAVAILABLE = "mailbox storage unavailable";

/**
 * Storage could not open the mailbox files, which were left as they are; a
 * retry later may succeed.
 */
export class MailboxUnavailableError extends Error {
  constructor(cause: unknown) {
    super(`${MAILBOX_UNAVAILABLE}: ${errorText(cause)}`, { cause });
    this.name = "MailboxUnavailableError";
  }
}
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_IOERR = 10;
const SQLITE_CORRUPT = 11;
const SQLITE_FULL = 13;
const SQLITE_NOTADB = 26;

/**
 * Classifies by result code and message text, since errors crossing a worker
 * boundary arrive as text.
 */
export function classifyMailboxError(
  error: unknown,
): MailboxOpenFailure | null {
  const code = readResultCode(error);
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return "corrupt";
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return "busy";
  // The OPFS SAH-pool VFS reports a full disk as an I/O error, not FULL.
  if (code === SQLITE_FULL || code === SQLITE_IOERR) return "unavailable";
  const text = errorText(error);
  // Checked first: the cause it wraps can read like a held file.
  if (text.includes(MAILBOX_UNAVAILABLE)) return "unavailable";
  if (
    text.includes("sqlite_corrupt") ||
    text.includes("sqlite_notadb") ||
    text.includes("database disk image is malformed") ||
    text.includes("not a database")
  ) {
    return "corrupt";
  }
  if (
    text.includes("sqlite_busy") ||
    text.includes("sqlite_locked") ||
    text.includes("database is locked") ||
    text.includes("nomodificationallowederror") ||
    text.includes("access handle") ||
    text.includes("timeouterror") ||
    text.includes("mailbox is in use")
  ) {
    return "busy";
  }
  if (
    text.includes("quotaexceedederror") ||
    text.includes("quota") ||
    text.includes("sqlite_full") ||
    text.includes("disk is full") ||
    text.includes("sqlite_ioerr") ||
    text.includes("disk i/o error") ||
    text.includes("securityerror")
  ) {
    return "unavailable";
  }
  return null;
}

function readResultCode(error: unknown) {
  if (!error || typeof error !== "object") return null;
  for (const field of ["resultCode", "errcode"]) {
    if (field in error) {
      const value = Number((error as Record<string, unknown>)[field]);
      // Extended result codes keep the primary code in the low byte.
      if (Number.isFinite(value)) return value & 0xff;
    }
  }
  return null;
}

function errorText(error: unknown) {
  if (error instanceof Error || (error && typeof error === "object")) {
    const { name, message } = error as { name?: unknown; message?: unknown };
    return `${String(name ?? "")}: ${String(message ?? "")}`.toLowerCase();
  }
  return String(error).toLowerCase();
}
