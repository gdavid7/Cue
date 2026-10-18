// The mail stream belongs to the mail engine; Today only needs to hear that
// Cue changed what needs a reply, so the two share a window event.
const TODAY_CHANGED_EVENT = "cue:today-changed";

/** Cue changed what needs a reply in an account, or in every one. */
export function announceTodayChanged(emailAccountId?: string) {
  window.dispatchEvent(
    new CustomEvent<string | undefined>(TODAY_CHANGED_EVENT, {
      detail: emailAccountId,
    }),
  );
}

export function onTodayChanged(listener: (emailAccountId?: string) => void) {
  const onEvent = (event: Event) =>
    listener(event instanceof CustomEvent ? event.detail : undefined);
  window.addEventListener(TODAY_CHANGED_EVENT, onEvent);
  return () => window.removeEventListener(TODAY_CHANGED_EVENT, onEvent);
}
