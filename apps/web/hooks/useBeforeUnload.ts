import { useEffect } from "react";
import { holdBuildReload } from "@/utils/build-reload";

/**
 * Shows a browser confirmation dialog when the user tries to leave the page.
 * @param enabled - Whether to show the warning (e.g., when there's unsaved work)
 */
export function useBeforeUnload(enabled: boolean) {
  useEffect(() => {
    if (!enabled) return;

    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      // Required for cross-browser compatibility (Safari needs returnValue set)
      e.returnValue = "";
      return "";
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    // Work the page asks not to leave also keeps it off a new build.
    const releaseBuildReload = holdBuildReload();
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
      releaseBuildReload();
    };
  }, [enabled]);
}
