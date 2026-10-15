import { useCallback } from "react";

// iOS Safari keeps the layout viewport (and with it `dvh` and `inset-0`)
// full height when the on-screen keyboard opens; only the visual viewport
// shrinks, and the page may scroll under it. A fixed panel sized from these
// vars stays within the visible area, so its footer sits above the keyboard.
// Written to the element instead of React state so keyboard animation and
// scroll events don't re-render what's inside.
export function useVisualViewportBox(enabled: boolean) {
  return useCallback(
    (element: HTMLElement | null) => {
      const viewport = window.visualViewport;
      if (!enabled || !element || !viewport) return;

      const update = () => {
        element.style.setProperty(
          "--visual-viewport-height",
          `${viewport.height}px`,
        );
        element.style.setProperty(
          "--visual-viewport-top",
          `${viewport.offsetTop}px`,
        );
      };

      update();
      viewport.addEventListener("resize", update);
      viewport.addEventListener("scroll", update);
      return () => {
        viewport.removeEventListener("resize", update);
        viewport.removeEventListener("scroll", update);
        element.style.removeProperty("--visual-viewport-height");
        element.style.removeProperty("--visual-viewport-top");
      };
    },
    [enabled],
  );
}
