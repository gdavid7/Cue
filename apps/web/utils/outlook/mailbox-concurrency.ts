import type { Context, Middleware } from "@microsoft/microsoft-graph-client";

// Graph lets an app run at most four requests at once against one mailbox
// (MailboxConcurrency) and answers the fifth with a 429.
export const MICROSOFT_MAILBOX_CONCURRENCY_LIMIT = 4;

type MailboxSlots = {
  inUse: number;
  waiting: Array<{ weight: number; grant: () => void }>;
};

// Keyed by access token, so every client for the same mailbox in this process
// shares one budget however many providers a request creates.
const slotsByMailbox = new Map<string, MailboxSlots>();

/**
 * Holds each Graph request until the mailbox has a free slot. A `$batch`
 * holds one slot per item, because Graph runs batch items concurrently.
 */
export class MailboxConcurrencyMiddleware implements Middleware {
  private next?: Middleware;
  private readonly getMailboxKey: () => string;

  constructor(getMailboxKey: () => string) {
    this.getMailboxKey = getMailboxKey;
  }

  setNext(next: Middleware) {
    this.next = next;
  }

  async execute(context: Context) {
    if (!this.next) throw new Error("Mailbox concurrency middleware is last");
    const release = await acquireMailboxSlots(
      this.getMailboxKey(),
      getRequestWeight(context),
    );
    try {
      await this.next.execute(context);
    } finally {
      release();
    }
  }
}

async function acquireMailboxSlots(key: string, weight: number) {
  let slots = slotsByMailbox.get(key);
  if (!slots) {
    slots = { inUse: 0, waiting: [] };
    slotsByMailbox.set(key, slots);
  }
  const mailbox = slots;

  if (
    mailbox.waiting.length === 0 &&
    mailbox.inUse + weight <= MICROSOFT_MAILBOX_CONCURRENCY_LIMIT
  ) {
    mailbox.inUse += weight;
  } else {
    await new Promise<void>((resolve) => {
      mailbox.waiting.push({ weight, grant: resolve });
    });
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    mailbox.inUse -= weight;
    // First come, first served, so a batch is never starved by single reads.
    while (
      mailbox.waiting[0] &&
      mailbox.inUse + mailbox.waiting[0].weight <=
        MICROSOFT_MAILBOX_CONCURRENCY_LIMIT
    ) {
      const next = mailbox.waiting.shift();
      if (!next) break;
      mailbox.inUse += next.weight;
      next.grant();
    }
    if (mailbox.inUse === 0 && mailbox.waiting.length === 0) {
      slotsByMailbox.delete(key);
    }
  };
}

function getRequestWeight(context: Context) {
  const url =
    typeof context.request === "string" ? context.request : context.request.url;
  if (!new URL(url).pathname.endsWith("/$batch")) return 1;

  const body = context.options?.body;
  if (typeof body !== "string") return MICROSOFT_MAILBOX_CONCURRENCY_LIMIT;
  try {
    const items = (JSON.parse(body) as { requests?: unknown[] }).requests;
    return Math.min(
      MICROSOFT_MAILBOX_CONCURRENCY_LIMIT,
      Math.max(1, items?.length ?? MICROSOFT_MAILBOX_CONCURRENCY_LIMIT),
    );
  } catch {
    return MICROSOFT_MAILBOX_CONCURRENCY_LIMIT;
  }
}
