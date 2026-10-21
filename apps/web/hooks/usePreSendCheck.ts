"use client";

import { useLocalStorage } from "usehooks-ts";

/**
 * Whether the composer pauses a send to point out a likely slip, such as a
 * missing attachment. Kept on this device, like the other display settings.
 */
export function usePreSendCheck() {
  // Read after mount so a saved `false` doesn't mismatch the server render.
  return useLocalStorage("cue.pre-send-check", true, {
    initializeWithValue: false,
  });
}
