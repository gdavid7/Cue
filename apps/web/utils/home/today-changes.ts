// The mail stream belongs to the mail engine; Today only needs to hear that
// Cue changed what needs a reply, so the two share a window event.
const TODAY_CHANGED_EVENT = "cue:today-changed";

export function announceTodayChanged() {
  window.dispatchEvent(new Event(TODAY_CHANGED_EVENT));
}

export function onTodayChanged(listener: () => void) {
  window.addEventListener(TODAY_CHANGED_EVENT, listener);
  return () => window.removeEventListener(TODAY_CHANGED_EVENT, listener);
}
