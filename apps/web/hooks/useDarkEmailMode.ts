"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  DARK_EMAIL_DEFAULT_KEY,
  type DarkEmailMode,
  darkEmailSendersKey,
  parseDarkEmailMode,
  parseSenderModes,
  rememberSenderDarkEmailMode,
  resolveDarkEmailMode,
} from "@/utils/email/dark-email-preference";

// Storage can be blocked or full; the choice then lasts for the session.
const fallbackValues = new Map<string, string>();
const listeners = new Set<() => void>();

/** Whether designed emails are adapted in dark mode unless a sender says otherwise. */
export function useDarkEmailDefault() {
  const defaultMode = parseDarkEmailMode(
    useStoredValue(DARK_EMAIL_DEFAULT_KEY),
  );
  const setDefaultMode = useCallback(
    (mode: DarkEmailMode) => writeStoredValue(DARK_EMAIL_DEFAULT_KEY, mode),
    [],
  );
  return [defaultMode, setDefaultMode] as const;
}

/** How a sender's designed emails show in dark mode, remembered per account. */
export function useDarkEmailMode(
  emailAccountId: string | undefined,
  sender: string | null | undefined,
) {
  const [defaultMode] = useDarkEmailDefault();
  const sendersKey = emailAccountId
    ? darkEmailSendersKey(emailAccountId)
    : null;
  const senderModes = parseSenderModes(useStoredValue(sendersKey));
  const mode = resolveDarkEmailMode({ defaultMode, senderModes, sender });

  const setMode = useCallback(
    (nextMode: DarkEmailMode) => {
      if (!sendersKey || !sender) return;
      const next = rememberSenderDarkEmailMode(
        parseSenderModes(readStoredValue(sendersKey)),
        { sender, mode: nextMode, defaultMode },
      );
      writeStoredValue(sendersKey, JSON.stringify(next));
    },
    [defaultMode, sender, sendersKey],
  );

  return { mode, setMode };
}

function useStoredValue(key: string | null) {
  return useSyncExternalStore(
    subscribe,
    () => (key ? readStoredValue(key) : null),
    () => null,
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStoredValue(key: string) {
  try {
    return window.localStorage.getItem(key) ?? fallbackValues.get(key) ?? null;
  } catch {
    return fallbackValues.get(key) ?? null;
  }
}

function writeStoredValue(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
    fallbackValues.delete(key);
  } catch {
    fallbackValues.set(key, value);
  }
  for (const listener of listeners) listener();
}
