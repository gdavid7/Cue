import type { StateAdapter } from "chat";

// Lists the Chat SDK fills with message text: a week of thread history for
// adapters without a history API (Telegram), and transcripts when enabled.
const MESSAGE_CONTENT_LIST_PREFIXES = ["msg-history:", "transcripts:"];
// Cached values that can quote a message. A modal's context holds the card
// it was opened from, with the notification's text.
const MESSAGE_CONTENT_CACHE_PREFIXES = ["modal-context:"];

/**
 * The Chat SDK's shared state, minus everything that would keep message text
 * in Redis (RD-3). Cue reads conversations from its own database. Slack's
 * "Edit draft" modal does open, but without its stored context the submit
 * arrives with no related message, and the card is updated through the Slack
 * message stored on the action instead. Cue runs the SDK's default "drop"
 * concurrency, which never queues a message; a queueing strategy would first
 * need entries without the message. Locks, dedupe keys, subscriptions and
 * callback ids pass through.
 */
export function withoutMessageContent<T extends StateAdapter>(state: T): T {
  const holdsContent = (key: string, prefixes: string[]) =>
    prefixes.some((prefix) => key.startsWith(prefix));

  return new Proxy(state, {
    get(target, property, receiver) {
      if (property === "appendToList") {
        return (key: string, ...rest: [unknown, never?]) =>
          holdsContent(key, MESSAGE_CONTENT_LIST_PREFIXES)
            ? Promise.resolve()
            : target.appendToList(key, ...rest);
      }
      if (property === "set") {
        return (key: string, ...rest: [unknown, number?]) =>
          holdsContent(key, MESSAGE_CONTENT_CACHE_PREFIXES)
            ? Promise.resolve()
            : target.set(key, ...rest);
      }
      if (property === "enqueue") {
        // Never reached with "drop"; if it were, the entry would carry the
        // whole message, so nothing is stored.
        return () => Promise.resolve(0);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
