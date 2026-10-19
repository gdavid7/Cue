type FocusMessage =
  | { type: "hello" }
  | { type: "state"; tabId: string; focused: boolean };

const FOCUS_CHANNEL = "cue:web-notifier-focus";

/**
 * Whether the reader is looking at any Cue tab, not just this one, so a
 * background tab that holds the notifier stays quiet while they read in another.
 */
export function trackCueTabFocus(deps: {
  channel: Pick<BroadcastChannel, "postMessage" | "close" | "onmessage"> | null;
  isThisTabFocused: () => boolean;
}) {
  const tabId = crypto.randomUUID();
  const focusedElsewhere = new Set<string>();
  const { channel } = deps;

  const announce = () =>
    channel?.postMessage({
      type: "state",
      tabId,
      focused: deps.isThisTabFocused(),
    } satisfies FocusMessage);

  const announceLeaving = () =>
    channel?.postMessage({
      type: "state",
      tabId,
      focused: false,
    } satisfies FocusMessage);

  if (channel) {
    channel.onmessage = (event: MessageEvent<FocusMessage>) => {
      const message = event.data;
      if (message.type === "hello") {
        announce();
        return;
      }
      if (message.focused) focusedElsewhere.add(message.tabId);
      else focusedElsewhere.delete(message.tabId);
    };
  }

  window.addEventListener("focus", announce);
  window.addEventListener("blur", announce);
  window.addEventListener("pagehide", announceLeaving);
  document.addEventListener("visibilitychange", announce);
  channel?.postMessage({ type: "hello" } satisfies FocusMessage);
  announce();

  return {
    isAnyTabFocused: () => deps.isThisTabFocused() || focusedElsewhere.size > 0,
    dispose() {
      window.removeEventListener("focus", announce);
      window.removeEventListener("blur", announce);
      window.removeEventListener("pagehide", announceLeaving);
      document.removeEventListener("visibilitychange", announce);
      channel?.postMessage({
        type: "state",
        tabId,
        focused: false,
      } satisfies FocusMessage);
      channel?.close();
    },
  };
}

export function openFocusChannel() {
  return typeof BroadcastChannel === "undefined"
    ? null
    : new BroadcastChannel(FOCUS_CHANNEL);
}
