"use client";

import { createContext, type ReactNode, useEffect, useState } from "react";
import { HotkeysProvider, useHotkeysContext } from "react-hotkeys-hook";
import {
  createSequencePrefixTracker,
  type ShortcutScope,
} from "@/lib/shortcuts/registry";

/**
 * One keyboard, one pending `g` or `*`: every `useShortcuts` under a provider
 * shares its tracker, so a second binding of the second key can't also fire.
 */
export const SequenceTrackerContext = createContext<ReturnType<
  typeof createSequencePrefixTracker
> | null>(null);

/**
 * Enables the given shortcut scopes for everything it wraps. Bindings from
 * other scopes stay registered but inert, so mail keys do nothing elsewhere.
 *
 * Pass a stable `scopes` array (a module constant) — it drives an effect.
 */
export function ShortcutsProvider({
  scopes,
  children,
}: {
  scopes: readonly ShortcutScope[];
  children: ReactNode;
}) {
  const [sequence] = useState(createSequencePrefixTracker);

  return (
    <HotkeysProvider initiallyActiveScopes={[...scopes]}>
      <SequenceTrackerContext.Provider value={sequence}>
        <ActiveScopes scopes={scopes} />
        {children}
      </SequenceTrackerContext.Provider>
    </HotkeysProvider>
  );
}

function ActiveScopes({ scopes }: { scopes: readonly ShortcutScope[] }) {
  const { activeScopes, enableScope, disableScope } = useHotkeysContext();

  useEffect(() => {
    for (const scope of scopes) {
      if (!activeScopes.includes(scope)) enableScope(scope);
    }
    for (const scope of activeScopes) {
      if (!scopes.includes(scope as ShortcutScope)) disableScope(scope);
    }
  }, [scopes, activeScopes, enableScope, disableScope]);

  return null;
}
