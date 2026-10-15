import * as React from "react";

const MOBILE_BREAKPOINT = 768;

export function useIsMobile() {
  const [isMobile, setIsMobile] = React.useState<boolean | undefined>(
    undefined,
  );

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`);
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    };
    mql.addEventListener("change", onChange);
    setIsMobile(window.innerWidth < MOBILE_BREAKPOINT);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return !!isMobile;
}

const LARGE_SCREEN_QUERY = "(min-width: 1024px)";

/**
 * Tailwind's `lg` and up, where the mail sidebar and the split reader fit.
 * Before hydration it assumes a large screen, the layout most sessions use.
 */
export function useIsLargeScreen() {
  return React.useSyncExternalStore(
    subscribeToLargeScreen,
    () => window.matchMedia?.(LARGE_SCREEN_QUERY).matches ?? true,
    () => true,
  );
}

function subscribeToLargeScreen(onChange: () => void) {
  const mql = window.matchMedia?.(LARGE_SCREEN_QUERY);
  mql?.addEventListener("change", onChange);
  return () => mql?.removeEventListener("change", onChange);
}

const COARSE_POINTER_QUERY = "(pointer: coarse)";

/** A touchscreen is the main input, so there's no hardware Shift+Return. */
export function useIsCoarsePointer() {
  return React.useSyncExternalStore(
    subscribeToCoarsePointer,
    () => window.matchMedia?.(COARSE_POINTER_QUERY).matches ?? false,
    () => false,
  );
}

function subscribeToCoarsePointer(onChange: () => void) {
  const mql = window.matchMedia?.(COARSE_POINTER_QUERY);
  mql?.addEventListener("change", onChange);
  return () => mql?.removeEventListener("change", onChange);
}
