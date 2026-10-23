import type { TabMailBus } from "@/utils/mail-engine/tab-channel";

const listeners = new Set<() => void>();

/** The SWR key every view's read of Important stars starts with. */
export const IMPORTANT_PEOPLE_KEY = "important-people";

export function isImportantPeopleKey(key: unknown) {
  return Array.isArray(key) && key[0] === IMPORTANT_PEOPLE_KEY;
}

/** This tab changed a star; other open tabs should read stars again. */
export function announceImportantPeopleChange() {
  for (const listener of [...listeners]) listener();
}

/**
 * Tells other tabs when this one changes a star, and calls `refresh` when
 * another tab does, so every tab's markers and Today order stay current.
 */
export function relayImportantPeopleChanges(
  bus: TabMailBus,
  refresh: () => void,
) {
  const announce = () => bus.post({ type: "importantPeopleChanged" });
  listeners.add(announce);
  const unsubscribe = bus.subscribe((message) => {
    if (message.type === "importantPeopleChanged") refresh();
  });
  return () => {
    listeners.delete(announce);
    unsubscribe();
  };
}
