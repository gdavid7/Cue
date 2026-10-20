import {
  type GetStartedClientStep,
  KEYBOARD_TRIAGE_GOAL,
} from "@/utils/get-started/checklist";

// Shortcuts that decide what happens to an email, not ones that move around.
const TRIAGE_SHORTCUT_IDS = new Set<string>([
  "archive",
  "archiveAndNext",
  "archiveAndPrevious",
  "delete",
  "snooze",
  "markSpam",
  "move",
  "label",
  "star",
  "markRead",
  "markUnread",
  "markImportant",
  "markNotImportant",
]);
const TRIAGE_COUNT_KEY = "cue:get-started:keyboard-triage";

type Listener = (step: GetStartedClientStep) => void;
const listeners = new Set<Listener>();
// What this page has counted, for when storage is blocked.
let pageTriageCount = 0;

/** Lets the recorder hear steps from code that has no React context. */
export function subscribeGetStartedSteps(listener: Listener) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function noteGetStartedStep(step: GetStartedClientStep) {
  for (const listener of listeners) listener(step);
}

/**
 * Counts triage done from the keyboard, across reloads in this browser, and
 * notes the step once there have been enough.
 */
export function noteShortcutForGetStarted(shortcutId: string) {
  if (!TRIAGE_SHORTCUT_IDS.has(shortcutId)) return;
  const stored = readTriageCount() ?? pageTriageCount;
  // Past the goal nothing is written; the recorder ignores a step it saved.
  if (stored >= KEYBOARD_TRIAGE_GOAL) {
    noteGetStartedStep("keyboard");
    return;
  }
  const count = stored + 1;
  pageTriageCount = count;
  writeTriageCount(count);
  if (count >= KEYBOARD_TRIAGE_GOAL) noteGetStartedStep("keyboard");
}

function readTriageCount() {
  try {
    return Number(localStorage.getItem(TRIAGE_COUNT_KEY)) || 0;
  } catch {
    return null;
  }
}

function writeTriageCount(count: number) {
  try {
    localStorage.setItem(TRIAGE_COUNT_KEY, String(count));
  } catch {
    // Private mode or blocked storage: this page's count stands in.
  }
}
