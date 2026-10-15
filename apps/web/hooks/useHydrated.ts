import { useSyncExternalStore } from "react";

/**
 * False in the server render and while hydrating, true once React has
 * hydrated. Disable a form's submit button until then: before hydration a
 * click submits the form natively, as a GET that puts its fields in the URL.
 */
export function useHydrated() {
  return useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );
}

function subscribeNever() {
  return () => {};
}
