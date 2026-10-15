import { useCallback, useLayoutEffect, useRef } from "react";

type Target = "reader" | "list";

/**
 * In list layout the list and the reader replace each other, so the focused
 * element unmounts and focus falls to the page. This puts it on the opened
 * conversation's subject, and back on the highlighted row on return, so
 * keyboard and screen-reader users continue where they were.
 */
export function useReaderFocusHandoff() {
  const listRef = useRef<HTMLElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Target | null>(null);

  // Runs after every render: the reader's subject can arrive renders after
  // the swap, once the conversation loads.
  useLayoutEffect(() => {
    const target = pending.current;
    if (!target) return;
    const destination = target === "reader" ? readerRef : listRef;
    const origin = target === "reader" ? listRef : readerRef;
    const active = document.activeElement;
    if (
      active &&
      active !== document.body &&
      !origin.current?.contains(active)
    ) {
      // Something else took focus first, such as an auto-opened reply.
      pending.current = null;
      return;
    }
    const element = destination.current?.querySelector<HTMLElement>(
      target === "reader"
        ? "[data-mail-reader-subject]"
        : '[data-mail-thread-row][tabindex="0"]',
    );
    if (!element) return;
    pending.current = null;
    element.focus({ preventScroll: target === "list" });
  });

  const focusReaderWhenShown = useCallback(() => {
    pending.current = "reader";
  }, []);
  const focusListWhenShown = useCallback(() => {
    pending.current = "list";
  }, []);

  return { listRef, readerRef, focusReaderWhenShown, focusListWhenShown };
}
