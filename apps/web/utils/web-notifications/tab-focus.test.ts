// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { trackCueTabFocus } from "@/utils/web-notifications/tab-focus";

// Two channels wired together the way BroadcastChannel instances of one name are.
function createChannelPair() {
  const make = () => ({
    onmessage: null as ((event: MessageEvent) => void) | null,
    peer: null as { onmessage: ((event: MessageEvent) => void) | null } | null,
    postMessage(data: unknown) {
      this.peer?.onmessage?.({ data } as MessageEvent);
    },
    close() {},
  });
  const a = make();
  const b = make();
  a.peer = b;
  b.peer = a;
  return [a, b];
}

describe("trackCueTabFocus", () => {
  it("knows when the reader is in another Cue tab", () => {
    const [channelA, channelB] = createChannelPair();
    const background = trackCueTabFocus({
      channel: channelA,
      isThisTabFocused: () => false,
    });
    expect(background.isAnyTabFocused()).toBe(false);

    const other = trackCueTabFocus({
      channel: channelB,
      isThisTabFocused: () => true,
    });
    expect(background.isAnyTabFocused()).toBe(true);

    other.dispose();
    expect(background.isAnyTabFocused()).toBe(false);
    background.dispose();
  });

  it("falls back to this tab alone without BroadcastChannel", () => {
    let focused = false;
    const tracker = trackCueTabFocus({
      channel: null,
      isThisTabFocused: () => focused,
    });
    expect(tracker.isAnyTabFocused()).toBe(false);
    focused = true;
    expect(tracker.isAnyTabFocused()).toBe(true);
    tracker.dispose();
  });
});
