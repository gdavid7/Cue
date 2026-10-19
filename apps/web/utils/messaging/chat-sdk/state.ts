import type { StateAdapter } from "chat";

// Lists the Chat SDK fills with message text: a week of thread history for
// adapters without a history API (Telegram), and transcripts when enabled.
const MESSAGE_CONTENT_LIST_PREFIXES = ["msg-history:", "transcripts:"];

/**
 * The Chat SDK's shared state, minus the lists that would keep message text
 * in Redis (RD-3). Cue reads conversations from its own database, so those
 * lists are never read back; locks, dedupe keys and subscriptions pass through.
 */
export function withoutMessageContent<T extends StateAdapter>(state: T): T {
  return new Proxy(state, {
    get(target, property, receiver) {
      if (property === "appendToList") {
        return (key: string, ...rest: [unknown, never?]) => {
          if (
            MESSAGE_CONTENT_LIST_PREFIXES.some((prefix) =>
              key.startsWith(prefix),
            )
          )
            return Promise.resolve();
          return target.appendToList(key, ...rest);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
