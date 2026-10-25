import {
  BellOffIcon,
  ArchiveIcon,
  ForwardIcon,
  KeyboardIcon,
  PenLineIcon,
  StarIcon,
  type LucideIcon,
} from "lucide-react";
import type { Command, CommandSection } from "@/lib/commands/types";
import { createClientLogger } from "@/utils/logger-client";

const logger = createClientLogger("shortcuts");

/**
 * `global` bindings are active anywhere the app mounts a `ShortcutsProvider`.
 * `mail` bindings are only active where the mail scope is enabled, so they are
 * inert on the rest of the app.
 */
export type ShortcutScope = "global" | "mail";

/** Every surface that binds mail keys also needs the global ones. */
export const MAIL_SHORTCUT_SCOPES: readonly ShortcutScope[] = [
  "global",
  "mail",
];

/** Display order of the `?` help dialog sections. */
export const SHORTCUT_GROUPS = [
  "Navigate",
  "Triage",
  "View",
  "Compose",
  "Assistant & rules",
] as const;

export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/** `g` then `a`: the second key has to land inside this window. */
export const SEQUENCE_TIMEOUT_MS = 900;

/** react-hotkeys-hook's sequence separator: `g>a` is "press g, then a". */
export const SEQUENCE_SPLIT_KEY = ">";

export type ShortcutHandler = (event?: KeyboardEvent) => void;

export type ShortcutHandlers = Partial<Record<ShortcutId, ShortcutHandler>>;

type ShortcutPalette = {
  section: CommandSection;
  description?: string;
  keywords?: readonly string[];
  priority?: number;
  icon?: LucideIcon;
};

export type ShortcutEntry = {
  id: string;
  /**
   * react-hotkeys-hook hotkey strings, matched against `event.key` so they
   * follow the character the user typed rather than the physical key.
   */
  keys: readonly string[];
  scope: ShortcutScope;
  group: ShortcutGroup;
  label: string;
  /** Overrides the keys rendered in the help dialog and the palette. */
  display?: readonly string[];
  /** Fires even while typing. Only for modifier combos and Escape. */
  allowWhileTyping?: boolean;
  /** Only available in the Electron shell, never in a browser tab. */
  desktopOnly?: boolean;
  /** Bound, but left out of the shortcuts sheet. */
  hideFromHelp?: boolean;
  /** Handles the key before rich text editors can consume it. */
  capture?: boolean;
  /** Present means the entry shows in ⌘K once a handler is registered. */
  palette?: ShortcutPalette;
  /** Fallback when no handler is injected at the call site. */
  action?: ShortcutHandler;
};

const SHORTCUT_DEFINITIONS = [
  {
    id: "toggleAutoArchive",
    keys: ["shift+e"],
    scope: "mail",
    group: "Triage",
    label: "Skip inbox for sender, or undo",
  },
  {
    id: "next",
    keys: ["j", "arrowdown"],
    scope: "mail",
    group: "Navigate",
    label: "Next message",
  },
  {
    id: "previous",
    keys: ["k", "arrowup"],
    scope: "mail",
    group: "Navigate",
    label: "Previous message",
  },
  {
    id: "open",
    keys: ["enter", "o"],
    scope: "mail",
    group: "Navigate",
    label: "Open message",
  },
  {
    id: "backToList",
    keys: ["escape"],
    scope: "mail",
    group: "Navigate",
    label: "Back to the list",
    allowWhileTyping: true,
  },
  {
    // Gmail's `u`. Escape also leaves a selection or search, which Gmail's
    // `u` does too, so both run the same handler.
    id: "returnToList",
    keys: ["u"],
    scope: "mail",
    group: "Navigate",
    label: "Back to the list",
  },
  {
    id: "nextMessage",
    keys: ["n"],
    scope: "mail",
    group: "Navigate",
    label: "Next message in the conversation",
  },
  {
    id: "previousMessage",
    keys: ["p"],
    scope: "mail",
    group: "Navigate",
    label: "Previous message in the conversation",
  },
  {
    id: "expandAllMessages",
    keys: [";"],
    scope: "mail",
    group: "Navigate",
    label: "Expand all messages",
  },
  {
    id: "collapseAllMessages",
    keys: [":", "shift+:"],
    display: [":"],
    scope: "mail",
    group: "Navigate",
    label: "Collapse all messages",
  },
  {
    id: "nextSplit",
    keys: ["tab"],
    scope: "mail",
    group: "Navigate",
    label: "Next split",
  },
  {
    id: "switchAccount",
    keys: [
      "mod+1",
      "mod+2",
      "mod+3",
      "mod+4",
      "mod+5",
      "mod+6",
      "mod+7",
      "mod+8",
      "mod+9",
    ],
    display: ["modorctrl+1–9"],
    scope: "mail",
    group: "Navigate",
    label: "Switch account",
    allowWhileTyping: true,
    desktopOnly: true,
  },
  {
    id: "switchAllAccounts",
    keys: ["mod+0"],
    display: ["modorctrl+0"],
    scope: "mail",
    group: "Navigate",
    label: "All accounts",
    allowWhileTyping: true,
    desktopOnly: true,
  },
  {
    id: "goToInbox",
    keys: ["g>i"],
    scope: "mail",
    group: "Navigate",
    label: "Go to Inbox",
  },
  {
    id: "goToStarred",
    keys: ["g>s"],
    scope: "mail",
    group: "Navigate",
    label: "Go to Starred",
  },
  {
    id: "goToSent",
    keys: ["g>t"],
    scope: "mail",
    group: "Navigate",
    label: "Go to Sent",
  },
  {
    id: "goToDrafts",
    keys: ["g>d"],
    scope: "mail",
    group: "Navigate",
    label: "Go to Drafts",
  },
  {
    id: "goToAllMail",
    keys: ["g>a"],
    scope: "mail",
    group: "Navigate",
    label: "Go to All Mail",
  },
  {
    id: "openExternal",
    keys: ["g>g"],
    scope: "mail",
    group: "Navigate",
    label: "Open in email provider",
  },
  {
    id: "commandPalette",
    keys: ["mod+k"],
    scope: "global",
    group: "Navigate",
    label: "Command palette",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "search",
    keys: ["/"],
    scope: "mail",
    group: "Navigate",
    label: "Search",
  },
  {
    id: "select",
    keys: ["x"],
    scope: "mail",
    group: "Triage",
    label: "Select",
  },
  {
    id: "selectAll",
    keys: ["mod+a", "shift+8>a"],
    display: ["mod+a", "*>a"],
    scope: "mail",
    group: "Triage",
    label: "Select all",
  },
  {
    // Bound as shift+8: react-hotkeys-hook reads a literal `*` as "any key".
    id: "selectNone",
    keys: ["shift+8>n"],
    display: ["*>n"],
    scope: "mail",
    group: "Triage",
    label: "Select none",
  },
  {
    id: "selectRead",
    keys: ["shift+8>r"],
    display: ["*>r"],
    scope: "mail",
    group: "Triage",
    label: "Select read",
  },
  {
    id: "selectUnread",
    keys: ["shift+8>u"],
    display: ["*>u"],
    scope: "mail",
    group: "Triage",
    label: "Select unread",
  },
  {
    id: "extendSelectionDown",
    keys: ["shift+arrowdown", "shift+j"],
    scope: "mail",
    group: "Triage",
    label: "Extend the selection down",
  },
  {
    id: "extendSelectionUp",
    keys: ["shift+arrowup", "shift+k"],
    scope: "mail",
    group: "Triage",
    label: "Extend the selection up",
  },
  {
    id: "archive",
    keys: ["e"],
    scope: "mail",
    group: "Triage",
    label: "Archive",
    palette: {
      section: "actions",
      description: "Archive current email",
      keywords: ["archive", "remove", "delete"],
      priority: 0,
      icon: ArchiveIcon,
    },
  },
  {
    id: "star",
    keys: ["s"],
    scope: "mail",
    group: "Triage",
    label: "Star / unstar",
    palette: {
      section: "actions",
      keywords: ["star", "unstar"],
      icon: StarIcon,
    },
  },
  {
    id: "label",
    keys: ["l"],
    scope: "mail",
    group: "Triage",
    label: "Label",
  },
  {
    id: "markRead",
    keys: ["shift+i"],
    scope: "mail",
    group: "Triage",
    label: "Mark as read",
  },
  {
    id: "markUnread",
    keys: ["shift+u"],
    scope: "mail",
    group: "Triage",
    label: "Mark as unread",
  },
  {
    id: "move",
    keys: ["v"],
    scope: "mail",
    group: "Triage",
    label: "Move",
  },
  {
    // `!` sits behind shift on US layouts and in front of it on others.
    id: "markSpam",
    keys: ["shift+!", "!"],
    display: ["!"],
    scope: "mail",
    group: "Triage",
    label: "Mark as spam",
  },
  {
    id: "snooze",
    keys: ["h", "b"],
    scope: "mail",
    group: "Triage",
    label: "Snooze",
  },
  {
    id: "archiveAndPrevious",
    keys: ["["],
    scope: "mail",
    group: "Triage",
    label: "Archive and go to the previous conversation",
  },
  {
    id: "archiveAndNext",
    keys: ["]"],
    scope: "mail",
    group: "Triage",
    label: "Archive and go to the next conversation",
  },
  {
    // `+` can't be written as a hotkey (it is the combo separator).
    id: "markImportant",
    keys: ["="],
    scope: "mail",
    group: "Triage",
    label: "Mark as important",
  },
  {
    id: "markNotImportant",
    keys: ["-"],
    scope: "mail",
    group: "Triage",
    label: "Mark as not important",
  },
  {
    // `#` sits behind shift on US layouts and in front of it on others.
    id: "delete",
    keys: ["shift+#", "#", "backspace"],
    display: ["#"],
    scope: "mail",
    group: "Triage",
    label: "Delete",
  },
  {
    id: "reply",
    keys: ["r"],
    scope: "mail",
    group: "Triage",
    label: "Reply",
  },
  {
    // Today's Waiting on rows only. `n` alone is the next message, and Cue
    // binds no other Shift+N.
    id: "nudge",
    keys: ["shift+n"],
    scope: "mail",
    group: "Triage",
    label: "Nudge someone you're waiting on",
  },
  {
    id: "replyAll",
    keys: ["a"],
    scope: "mail",
    group: "Triage",
    label: "Reply all",
  },
  {
    id: "forward",
    keys: ["f"],
    scope: "mail",
    group: "Triage",
    label: "Forward",
    palette: {
      section: "actions",
      keywords: ["forward", "send", "share"],
      priority: 4,
      icon: ForwardIcon,
    },
  },
  {
    id: "moreActions",
    keys: ["."],
    scope: "mail",
    group: "Triage",
    label: "More actions",
  },
  {
    // Gmail's `m`. Muting lives in Cue's database, not a mailbox label.
    id: "mute",
    keys: ["m"],
    scope: "mail",
    group: "Triage",
    label: "Mute conversation",
    palette: {
      section: "actions",
      description: "Archive it now and keep new replies out of the inbox",
      keywords: ["mute", "silence", "ignore"],
      icon: BellOffIcon,
    },
  },
  {
    // `m` is Gmail's mute; comments take the shifted key beside it.
    id: "openTeamComments",
    keys: ["shift+m"],
    scope: "mail",
    group: "View",
    label: "Comment for your team",
    // Team comments are for shared workspaces, not someone's own inbox.
    hideFromHelp: true,
  },
  {
    id: "undo",
    keys: ["z"],
    scope: "mail",
    group: "Triage",
    label: "Undo last action",
  },
  {
    // Free in Gmail too (its `I` is shift+i, mark as read).
    id: "showPersonCard",
    keys: ["i"],
    scope: "mail",
    group: "View",
    label: "Sender's contact card",
  },
  {
    id: "translate",
    keys: ["shift+t"],
    scope: "mail",
    group: "View",
    label: "Translate / show original",
  },
  {
    id: "toggleLayout",
    keys: ["shift+v"],
    scope: "mail",
    group: "View",
    label: "List view / split view",
  },
  {
    id: "togglePreview",
    keys: ["shift+p"],
    scope: "mail",
    group: "View",
    label: "Short / expanded preview text",
  },
  {
    id: "help",
    keys: ["shift+?", "?"],
    display: ["?"],
    scope: "mail",
    group: "View",
    label: "Keyboard shortcuts",
    palette: {
      section: "settings",
      keywords: ["shortcuts", "keyboard", "hotkeys", "help"],
      icon: KeyboardIcon,
    },
  },
  {
    id: "compose",
    keys: ["c"],
    scope: "global",
    group: "Compose",
    label: "New message",
    palette: {
      section: "actions",
      keywords: ["compose", "write", "email"],
      priority: 20,
      icon: PenLineIcon,
    },
  },
  {
    id: "send",
    keys: ["mod+enter"],
    scope: "mail",
    group: "Compose",
    label: "Send",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "sendAndMarkDone",
    keys: ["mod+shift+enter"],
    scope: "mail",
    group: "Compose",
    label: "Send and mark done",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "saveDraft",
    keys: ["mod+s"],
    scope: "mail",
    group: "Compose",
    label: "Save draft",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "addCc",
    keys: ["mod+shift+c"],
    scope: "mail",
    group: "Compose",
    label: "Add Cc recipients",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "addBcc",
    keys: ["mod+shift+b"],
    scope: "mail",
    group: "Compose",
    label: "Add Bcc recipients",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "askCue",
    keys: ["mod+j"],
    scope: "mail",
    group: "Compose",
    label: "Ask Cue to write or rewrite",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "sendLater",
    keys: ["mod+shift+l"],
    scope: "mail",
    group: "Compose",
    label: "Send later",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "remindMe",
    keys: ["mod+shift+h"],
    scope: "mail",
    group: "Compose",
    label: "Remind me",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "attachFiles",
    keys: ["mod+shift+u"],
    scope: "mail",
    group: "Compose",
    label: "Attach files",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "popOutDraft",
    keys: ["mod+shift+p"],
    scope: "mail",
    group: "Compose",
    label: "Pop out draft",
    allowWhileTyping: true,
    capture: true,
  },
  {
    id: "discardDraft",
    keys: ["mod+shift+,", "mod+shift+<"],
    display: ["mod+shift+,"],
    scope: "mail",
    group: "Compose",
    label: "Discard draft",
    allowWhileTyping: true,
    capture: true,
  },
] as const satisfies readonly ShortcutEntry[];

export type ShortcutId = (typeof SHORTCUT_DEFINITIONS)[number]["id"];

/** The single source of truth behind key handling, `?` help and ⌘K. */
export const SHORTCUTS: readonly ShortcutEntry[] = SHORTCUT_DEFINITIONS;

const SHORTCUTS_BY_ID = new Map(SHORTCUTS.map((entry) => [entry.id, entry]));

export type ShortcutConflict = {
  key: string;
  ids: string[];
};

type ShortcutKeyOwner = {
  id: string;
  scope: ShortcutScope;
  viaPrefix: boolean;
};

export function getShortcut(id: ShortcutId): ShortcutEntry {
  const entry = SHORTCUTS_BY_ID.get(id);
  if (!entry) throw new Error(`Unknown shortcut: ${id}`);
  return entry;
}

export function getShortcutsForScopes(
  scopes: readonly ShortcutScope[],
  { isDesktopApp = false }: { isDesktopApp?: boolean } = {},
): ShortcutEntry[] {
  return SHORTCUTS.filter(
    (entry) =>
      scopes.includes(entry.scope) && (!entry.desktopOnly || isDesktopApp),
  );
}

/** Feeds the `?` help dialog so it can never drift from the handlers. */
export function getShortcutGroups(
  scopes: readonly ShortcutScope[],
  options: { isDesktopApp?: boolean } = {},
): { group: ShortcutGroup; shortcuts: ShortcutEntry[] }[] {
  const entries = getShortcutsForScopes(scopes, options).filter(
    (entry) => !entry.hideFromHelp,
  );

  return SHORTCUT_GROUPS.map((group) => ({
    group,
    shortcuts: entries.filter((entry) => entry.group === group),
  })).filter(({ shortcuts }) => shortcuts.length > 0);
}

/** The keys as shown to the user, e.g. `⌘K`, `J / ↓`, `G A`. */
export function formatShortcutKeys(entry: ShortcutEntry): string {
  const keys = entry.display ?? entry.keys;
  return keys.map(formatKey).join(" / ");
}

export function getShortcutHint(id: ShortcutId): string {
  return formatShortcutKeys(getShortcut(id));
}

/**
 * One label per key of the first binding, e.g. `["⌘", "shift", "enter"]`, for
 * surfaces that render a key per block. Modifiers are spelled out because the
 * stacked symbols (`⌘⇧↵`) are unreadable at tooltip size.
 */
export function getShortcutKeyLabels(id: ShortcutId): string[] {
  const entry = getShortcut(id);
  const [binding] = entry.display ?? entry.keys;

  return binding
    .split(SEQUENCE_SPLIT_KEY)
    .flatMap((step) => step.split("+"))
    .map((token) => formatKeyToken(token, true));
}

/** Feeds ⌘K: an entry appears once its handler is registered. */
export function buildShortcutPaletteCommands(
  handlers: ShortcutHandlers,
): Command[] {
  const commands: (Command & { priority: number })[] = [];

  for (const entry of SHORTCUTS) {
    const palette = entry.palette;
    if (!palette) continue;

    const handler = handlers[entry.id as ShortcutId] ?? entry.action;
    if (!handler) continue;

    commands.push({
      id: entry.id,
      label: entry.label,
      description: palette.description,
      icon: palette.icon,
      shortcut: formatShortcutKeys(entry),
      section: palette.section,
      priority: palette.priority ?? 50,
      keywords: palette.keywords ? [...palette.keywords] : undefined,
      action: () => handler(),
    });
  }

  return commands.sort((a, b) => a.priority - b.priority);
}

/**
 * Two entries owning the same key fire both handlers. Scopes that are never
 * active together are allowed to reuse a key; `global` is active alongside
 * everything, so it never can.
 */
export function findShortcutConflicts(
  entries: readonly ShortcutEntry[],
): ShortcutConflict[] {
  const owners = new Map<string, ShortcutKeyOwner[]>();

  for (const entry of entries) {
    for (const key of entry.keys) {
      addOwner(owners, key, entry, false);
      // Reserve the sequence prefix: a plain `g` binding would swallow `g>a`.
      const [prefix] = key.split(SEQUENCE_SPLIT_KEY);
      if (prefix !== key) addOwner(owners, prefix, entry, true);
    }
  }

  const conflicts: ShortcutConflict[] = [];

  for (const [key, keyOwners] of owners) {
    const clashing = keyOwners.filter((owner) =>
      keyOwners.some(
        (other) =>
          other.id !== owner.id &&
          scopesOverlap(owner.scope, other.scope) &&
          // Two sequences may share a prefix (`g>a` and `g>i`).
          !(owner.viaPrefix && other.viaPrefix),
      ),
    );
    if (clashing.length > 1) {
      conflicts.push({ key, ids: clashing.map((owner) => owner.id) });
    }
  }

  return conflicts;
}

export function assertNoShortcutConflicts(
  entries: readonly ShortcutEntry[],
): void {
  const conflicts = findShortcutConflicts(entries);
  if (conflicts.length === 0) return;
  throw new Error(`Conflicting shortcuts: ${describeConflicts(conflicts)}`);
}

/**
 * Marks a container whose keys belong to what is being written there, even
 * while focus rests on the container itself rather than a field inside it.
 */
export const TYPING_SURFACE_ATTRIBUTE = "data-typing-surface";

/**
 * Marks a surface over the mail, such as a popover, whose keys are its own:
 * no mail-scope shortcut runs from inside it, so `e` there never archives
 * the conversation behind it.
 */
export const MAIL_SHORTCUTS_OFF_ATTRIBUTE = "data-mail-shortcuts-off";
/**
 * The attribute's value for a surface that takes over the keyboard, such as
 * Catch up's overlay: global shortcuts like `c` and ⌘K stay off there too.
 */
export const ALL_SHORTCUTS_OFF = "all";

/** Bindings stay inert while the user is typing, unless they're a ⌘ combo. */
export function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element?.tagName) return false;
  if (element.hasAttribute?.(TYPING_SURFACE_ATTRIBUTE)) return true;

  const tagName = element.tagName.toUpperCase();
  if (tagName === "INPUT" || tagName === "TEXTAREA" || tagName === "SELECT") {
    return true;
  }
  if (element.isContentEditable) return true;
  if (element.getAttribute?.("role") === "textbox") return true;

  return !!element.closest?.(
    "[contenteditable]:not([contenteditable='false'])",
  );
}

/**
 * Tracks a pending sequence prefix (`g`) so the plain binding for the second
 * key (`a` = reply all) stays quiet while a sequence is in flight.
 */
export function createSequencePrefixTracker(now: () => number = Date.now) {
  let prefix: string | null = null;
  let startedAt = 0;
  let resolvedBy: KeyboardEvent | null = null;

  return {
    start(key: string) {
      prefix = key;
      startedAt = now();
      resolvedBy = null;
    },
    pendingPrefix(): string | null {
      if (prefix && now() - startedAt >= SEQUENCE_TIMEOUT_MS) prefix = null;
      return prefix;
    },
    /**
     * A completed sequence and the plain binding for its last key are matched
     * by the same event, in an order we do not control.
     */
    resolve(event: KeyboardEvent) {
      prefix = null;
      resolvedBy = event;
    },
    wasResolvedBy(event: KeyboardEvent): boolean {
      return resolvedBy === event;
    },
    clear() {
      prefix = null;
    },
  };
}

// A conflicting registry is a bug, not a runtime condition: fail loudly while
// developing, and report it rather than crash a production session.
if (process.env.NODE_ENV === "production") {
  const conflicts = findShortcutConflicts(SHORTCUTS);
  if (conflicts.length > 0) {
    logger.error("Conflicting shortcuts", {
      conflicts: describeConflicts(conflicts),
    });
  }
} else {
  assertNoShortcutConflicts(SHORTCUTS);
}

const KEY_SYMBOLS: Record<string, string> = {
  mod: "⌘",
  meta: "⌘",
  ctrl: "⌃",
  alt: "⌥",
  shift: "⇧",
  enter: "↵",
  escape: "Esc",
  tab: "Tab",
  backspace: "⌫",
  space: "Space",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
};

/** Overrides `KEY_SYMBOLS` where a word reads better than a symbol. */
const KEY_WORDS: Record<string, string> = {
  ctrl: "ctrl",
  alt: "option",
  shift: "shift",
  enter: "enter",
  escape: "esc",
  tab: "tab",
  backspace: "delete",
  space: "space",
};

function formatKey(key: string): string {
  return key
    .split(SEQUENCE_SPLIT_KEY)
    .map((step) =>
      step
        .split("+")
        .map((token) => formatKeyToken(token))
        .join(""),
    )
    .join(" ");
}

function formatKeyToken(token: string, spelledOut = false): string {
  if (token === "modorctrl") {
    const isMac =
      typeof window === "undefined" ||
      /Mac|iPhone|iPod|iPad/.test(window.navigator.userAgent);

    if (isMac) return "⌘";
    return spelledOut ? "Ctrl" : "Ctrl+";
  }

  return (
    (spelledOut ? KEY_WORDS[token] : undefined) ??
    KEY_SYMBOLS[token] ??
    token.toUpperCase()
  );
}

function addOwner(
  owners: Map<string, ShortcutKeyOwner[]>,
  key: string,
  entry: ShortcutEntry,
  viaPrefix: boolean,
) {
  const existing = owners.get(key);
  if (viaPrefix && existing?.some((owner) => owner.id === entry.id)) return;

  const owner = { id: entry.id, scope: entry.scope, viaPrefix };
  if (existing) existing.push(owner);
  else owners.set(key, [owner]);
}

function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === b || a === "global" || b === "global";
}

function describeConflicts(conflicts: ShortcutConflict[]): string {
  return conflicts
    .map(({ key, ids }) => `${key} (${ids.join(", ")})`)
    .join("; ");
}
