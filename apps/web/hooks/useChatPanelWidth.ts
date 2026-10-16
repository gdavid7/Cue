import { useSyncExternalStore } from "react";

export const CHAT_PANEL_DEFAULT_WIDTH = 450;
export const CHAT_PANEL_MIN_WIDTH = 400;
// Beyond this the mail list and reader get too narrow to work with.
const CHAT_PANEL_MAX_VIEWPORT_FRACTION = 0.6;
const STORAGE_KEY = "cue:chat-panel-width";

const listeners = new Set<() => void>();
// The width while a drag is in flight; saved to storage only on release.
let draggingWidth: number | null = null;
// Holds the chosen width when storage is blocked, so resizing still works for
// the session.
let unsavedWidth: number | null = null;

export function clampChatPanelWidth(width: number, viewportWidth: number) {
  const max = Math.max(
    CHAT_PANEL_MIN_WIDTH,
    Math.floor(viewportWidth * CHAT_PANEL_MAX_VIEWPORT_FRACTION),
  );
  return Math.round(Math.min(Math.max(width, CHAT_PANEL_MIN_WIDTH), max));
}

export function getChatPanelWidthBounds() {
  return {
    min: CHAT_PANEL_MIN_WIDTH,
    max: clampChatPanelWidth(Number.POSITIVE_INFINITY, window.innerWidth),
  };
}

/**
 * The assistant panel's width in pixels on large screens. The server and the
 * first client render use the default, so hydration matches; the stored
 * width applies right after, while the panel is still closed.
 */
export function useChatPanelWidth() {
  return useSyncExternalStore(
    subscribe,
    getChatPanelWidth,
    () => CHAT_PANEL_DEFAULT_WIDTH,
  );
}

/**
 * A ref for the layout element: keeps `--chat-panel-width` and
 * `data-chat-panel-resizing` on it in step with the store, so a drag restyles
 * the layout every frame without re-rendering it. Before this runs, CSS falls
 * back to the default width.
 */
export function bindChatPanelWidth(element: HTMLElement | null) {
  if (!element) return;
  const apply = () => {
    element.style.setProperty("--chat-panel-width", `${getChatPanelWidth()}px`);
    element.toggleAttribute("data-chat-panel-resizing", draggingWidth !== null);
  };
  apply();
  return subscribe(apply);
}

export function getChatPanelWidth() {
  return clampChatPanelWidth(
    draggingWidth ??
      readStoredWidth() ??
      unsavedWidth ??
      CHAT_PANEL_DEFAULT_WIDTH,
    window.innerWidth,
  );
}

export function previewChatPanelWidth(width: number) {
  draggingWidth = clampChatPanelWidth(width, window.innerWidth);
  notify();
}

/** Drops an unfinished drag and returns to the saved width. */
export function cancelChatPanelDrag() {
  if (draggingWidth === null) return;
  draggingWidth = null;
  notify();
}

export function saveChatPanelWidth(width: number) {
  const clamped = clampChatPanelWidth(width, window.innerWidth);
  draggingWidth = null;
  unsavedWidth = clamped;
  try {
    window.localStorage.setItem(STORAGE_KEY, String(clamped));
  } catch {}
  notify();
}

export function resetChatPanelWidth() {
  draggingWidth = null;
  unsavedWidth = null;
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {}
  notify();
}

function readStoredWidth() {
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    return stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

function subscribe(onChange: () => void) {
  listeners.add(onChange);
  window.addEventListener("resize", onChange);
  // Another tab saved or reset the width.
  window.addEventListener("storage", onChange);
  return () => {
    listeners.delete(onChange);
    window.removeEventListener("resize", onChange);
    window.removeEventListener("storage", onChange);
  };
}

function notify() {
  for (const listener of listeners) listener();
}
