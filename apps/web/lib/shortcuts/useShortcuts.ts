"use client";

import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useMemo,
  useContext,
  useRef,
  useState,
} from "react";
import { type HotkeyCallback, useHotkeys } from "react-hotkeys-hook";
import { SequenceTrackerContext } from "@/lib/shortcuts/ShortcutsProvider";
import {
  createSequencePrefixTracker,
  isTypingTarget,
  ALL_SHORTCUTS_OFF,
  MAIL_SHORTCUTS_OFF_ATTRIBUTE,
  SEQUENCE_SPLIT_KEY,
  type ShortcutEntry,
  type ShortcutHandlers,
  type ShortcutId,
  type ShortcutScope,
  SHORTCUTS,
} from "@/lib/shortcuts/registry";
import { trackMailAction } from "@/utils/analytics/mail-usage";

type HotkeysEvent = Parameters<HotkeyCallback>[1];

type SequenceTracker = ReturnType<typeof createSequencePrefixTracker>;

const HOTKEYS_DELIMITER = "|";

type ShortcutTarget =
  | { type: "entry"; entry: ShortcutEntry }
  | { type: "prefix"; key: string }
  /** The last key of a sequence, listened for only to complete it. */
  | { type: "sequenceEnd" };

type ShortcutBucket = {
  scope: ShortcutScope;
  allowWhileTyping: boolean;
  capture: boolean;
  /** Kept as entries so the comma key is distinct from the list delimiter. */
  keys: string[];
  targets: Map<string, ShortcutTarget>;
  /** `g>s` and the like. Matched here, not by react-hotkeys-hook: its one
   * sequence buffer per hook breaks once a hook holds two sequences. */
  sequences: Map<string, ShortcutEntry>;
};

// react-hotkeys-hook takes scope and typing behaviour per hook, so bindings are
// registered as one hook per combination rather than one hook per shortcut.
const BUCKET_SPECS = [
  { scope: "global", allowWhileTyping: false, capture: false },
  { scope: "global", allowWhileTyping: false, capture: true },
  { scope: "global", allowWhileTyping: true, capture: false },
  { scope: "global", allowWhileTyping: true, capture: true },
  { scope: "mail", allowWhileTyping: false, capture: false },
  { scope: "mail", allowWhileTyping: false, capture: true },
  { scope: "mail", allowWhileTyping: true, capture: false },
  { scope: "mail", allowWhileTyping: true, capture: true },
] as const satisfies readonly {
  scope: ShortcutScope;
  allowWhileTyping: boolean;
  capture: boolean;
}[];

/**
 * Binds the registry entries the caller supplies a handler for. Entries without
 * a handler and desktop-only entries outside Electron keep their browser default.
 */
export function useShortcuts(
  handlers: ShortcutHandlers,
  { isDesktopApp = false }: { isDesktopApp?: boolean } = {},
): void {
  const handlersRef = useRef(handlers);
  useLayoutEffect(() => {
    // Suspended renders must not replace the visible screen's handlers.
    handlersRef.current = handlers;
  }, [handlers]);

  const [ownSequence] = useState(createSequencePrefixTracker);
  const sequence = useContext(SequenceTrackerContext) ?? ownSequence;

  const signature = activeShortcutIds(handlers, isDesktopApp).join(",");
  const buckets = useMemo(() => buildBuckets(signature), [signature]);
  const allSequences = useMemo(
    () => new Set(buckets.flatMap((bucket) => [...bucket.sequences.keys()])),
    [buckets],
  );
  const ownPrefixes = useMemo(
    () =>
      new Set([...allSequences].map((key) => key.split(SEQUENCE_SPLIT_KEY)[0])),
    [allSequences],
  );

  useShortcutBucket(
    buckets[0],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[1],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[2],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[3],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[4],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[5],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[6],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
  useShortcutBucket(
    buckets[7],
    handlersRef,
    sequence,
    allSequences,
    ownPrefixes,
  );
}

function useShortcutBucket(
  bucket: ShortcutBucket,
  handlersRef: RefObject<ShortcutHandlers>,
  sequence: SequenceTracker,
  /** Every bucket's sequences: the one completing a press may be another's. */
  allSequences: Set<string>,
  /** Prefixes this hook starts; any other pending prefix belongs to another hook. */
  ownPrefixes: Set<string>,
) {
  const onHotkey = useCallback<HotkeyCallback>(
    (event, hotkeysEvent) => {
      const target = resolveTarget(bucket, event, hotkeysEvent);
      if (!target) return;
      const key = hotkeysEvent.hotkey;

      // Every bucket hears the same keydown; one completing a sequence with
      // it means it isn't also a plain shortcut: `a` after `g` isn't reply all.
      if (sequence.wasResolvedBy(event)) return;

      const pendingPrefix = sequence.pendingPrefix();
      // A prefix another hook started is its to complete or abandon; acting
      // on the key here would fire a plain binding mid-sequence.
      if (pendingPrefix && !ownPrefixes.has(pendingPrefix)) return;
      if (pendingPrefix) {
        const sequenceKey = `${pendingPrefix}${SEQUENCE_SPLIT_KEY}${key}`;
        const sequenceEntry = bucket.sequences.get(sequenceKey);
        if (sequenceEntry) {
          sequence.resolve(event);
          event.preventDefault();
          runEntry(handlersRef, sequenceEntry, event, sequenceKey);
          return;
        }
        // Another bucket owns this sequence and will complete it.
        if (allSequences.has(sequenceKey)) return;
        // An abandoned prefix must not eat the next key: after `g`, a `j`
        // still moves.
        sequence.clear();
      }

      if (target.type === "prefix") {
        sequence.start(target.key);
        return;
      }
      if (target.type === "sequenceEnd") return;

      runEntry(handlersRef, target.entry, event, key);
    },
    [allSequences, bucket, handlersRef, ownPrefixes, sequence],
  );

  const preventDefault = useCallback(
    (event: KeyboardEvent, hotkeysEvent: HotkeysEvent) => {
      const target = resolveTarget(bucket, event, hotkeysEvent);
      if (target?.type !== "entry") return false;
      // A press that completes a sequence is left for the sequence's own
      // bucket, which skips events another listener has already claimed.
      const pendingPrefix = sequence.pendingPrefix();
      // A foreign prefix means the press is that hook's to complete.
      if (pendingPrefix && !ownPrefixes.has(pendingPrefix)) return false;
      return !(
        pendingPrefix &&
        allSequences.has(
          `${pendingPrefix}${SEQUENCE_SPLIT_KEY}${hotkeysEvent.hotkey}`,
        )
      );
    },
    [allSequences, bucket, ownPrefixes, sequence],
  );

  useHotkeys(bucket.keys, onHotkey, {
    enabled: bucket.keys.length > 0,
    scopes: [bucket.scope],
    // Hotkeys are matched on the typed character so they survive keyboard
    // layouts that move `#` or `?`.
    useKey: true,
    // react-hotkeys-hook treats any focused `role="option"` like a form field.
    // A focused conversation row is where triage keys belong, so options are
    // let through here and every option but a mail row is ignored below.
    enableOnFormTags: bucket.allowWhileTyping ? true : ["option"],
    enableOnContentEditable: bucket.allowWhileTyping,
    delimiter: HOTKEYS_DELIMITER,
    eventListenerOptions: bucket.capture ? { capture: true } : undefined,
    ignoreEventWhen: (event: KeyboardEvent) =>
      event.defaultPrevented ||
      (!bucket.allowWhileTyping && isNonMailOption(event.target)),
    preventDefault,
  });
}

function runEntry(
  handlersRef: RefObject<ShortcutHandlers>,
  entry: ShortcutEntry,
  event: KeyboardEvent,
  key: string,
) {
  const handler = handlersRef.current[entry.id as ShortcutId] ?? entry.action;
  if (!handler) return;
  handler(event);
  trackMailAction({ action: entry.id, source: "shortcut", shortcut: key });
}

function activeShortcutIds(
  handlers: ShortcutHandlers,
  isDesktopApp: boolean,
): string[] {
  return SHORTCUTS.filter(
    (entry) =>
      (!entry.desktopOnly || isDesktopApp) &&
      (handlers[entry.id as ShortcutId] ?? entry.action),
  ).map((entry) => entry.id);
}

function buildBuckets(signature: string): ShortcutBucket[] {
  const activeIds = new Set(signature ? signature.split(",") : []);

  return BUCKET_SPECS.map((spec) => {
    const targets = new Map<string, ShortcutTarget>();
    const sequences = new Map<string, ShortcutEntry>();
    const sequenceEnds = new Set<string>();

    for (const entry of SHORTCUTS) {
      if (!activeIds.has(entry.id)) continue;
      if (entry.scope !== spec.scope) continue;
      if (!!entry.allowWhileTyping !== spec.allowWhileTyping) continue;
      if (!!entry.capture !== spec.capture) continue;

      for (const key of entry.keys) {
        const [prefix, last] = key.split(SEQUENCE_SPLIT_KEY);
        if (last === undefined) {
          targets.set(key, { type: "entry", entry });
          continue;
        }
        sequences.set(key, entry);
        sequenceEnds.add(last);
        if (targets.get(prefix)?.type !== "entry") {
          targets.set(prefix, { type: "prefix", key: prefix });
        }
      }
    }

    for (const last of sequenceEnds) {
      if (!targets.has(last)) targets.set(last, { type: "sequenceEnd" });
    }

    return {
      scope: spec.scope,
      allowWhileTyping: spec.allowWhileTyping,
      capture: spec.capture,
      keys: [...targets.keys()],
      targets,
      sequences,
    };
  });
}

function resolveTarget(
  bucket: ShortcutBucket,
  event: KeyboardEvent,
  hotkeysEvent: HotkeysEvent,
): ShortcutTarget | undefined {
  if (!bucket.allowWhileTyping && isTypingTarget(event.target)) return;
  if (isActivationKey(event) && activatesOnEnter(event.target)) return;
  const shortcutsOff =
    event.target instanceof Element
      ? event.target.closest(`[${MAIL_SHORTCUTS_OFF_ATTRIBUTE}]`)
      : null;
  if (
    shortcutsOff &&
    (bucket.scope === "mail" ||
      shortcutsOff.getAttribute(MAIL_SHORTCUTS_OFF_ATTRIBUTE) ===
        ALL_SHORTCUTS_OFF)
  )
    return;
  const target = bucket.targets.get(hotkeysEvent.hotkey);
  if (
    target?.type === "entry" &&
    target.entry.id === "commandPalette" &&
    event.target instanceof Element &&
    event.target.closest("[data-email-editor-root]")
  ) {
    return;
  }
  if (
    target?.type === "entry" &&
    ["backToList", "open", "nextSplit", "search"].includes(target.entry.id) &&
    event.target instanceof Element &&
    event.target.closest('[role="dialog"]')
  ) {
    return;
  }
  return target;
}

// A plain Enter on a focused button, link or menu item is that control's own
// activation; a shortcut bound to Enter must not run in its place.
const ACTIVATES_ON_ENTER = [
  "button",
  "a[href]",
  "summary",
  '[role="button"]',
  '[role="link"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[role="tab"]',
].join(",");

function isActivationKey(event: KeyboardEvent) {
  return (
    event.key === "Enter" &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.shiftKey
  );
}

function activatesOnEnter(target: EventTarget | null) {
  return target instanceof Element && target.matches(ACTIVATES_ON_ENTER);
}

function isNonMailOption(target: EventTarget | null) {
  return (
    target instanceof Element &&
    target.getAttribute("role") === "option" &&
    !target.hasAttribute("data-mail-thread-row")
  );
}
