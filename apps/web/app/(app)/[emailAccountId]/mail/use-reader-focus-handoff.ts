import { useCallback, useLayoutEffect, useRef } from "react";

type Request = (
  | { target: "reader"; threadKey: string }
  | { target: "list"; threadKey: null }
) & { reached: boolean };

/**
 * In list layout the list and the reader replace each other, so the focused
 * element unmounts and focus falls to the page. This puts it on the opened
 * conversation's subject, and back on the highlighted row on return, so
 * keyboard and screen-reader users continue where they were.
 */
export function useReaderFocusHandoff(openThreadKey: string | null) {
  const listRef = useRef<HTMLElement>(null);
  const readerRef = useRef<HTMLDivElement>(null);
  const pending = useRef<Request | null>(null);

  // Runs after every render: the reader's subject can arrive renders after
  // the swap, once the conversation loads.
  useLayoutEffect(() => {
    const request = pending.current;
    if (!request) return;
    // The address, and so the open key, can update a render after the
    // request. Once it has caught up, a change means another conversation
    // opened, or the reader closed, before this one showed.
    if (request.threadKey !== openThreadKey) {
      if (request.reached) pending.current = null;
      return;
    }
    request.reached = true;
    const toReader = request.target === "reader";
    const destination = toReader ? readerRef : listRef;
    const origin = toReader ? listRef : readerRef;
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
      toReader
        ? "[data-mail-reader-subject]"
        : '[data-mail-thread-row][tabindex="0"]',
    );
    if (!element) {
      // A list that comes back empty has no row to return to; waiting would
      // let a later row take focus out of nowhere.
      if (!toReader && destination.current) pending.current = null;
      return;
    }
    pending.current = null;
    element.focus({ preventScroll: true });
  });

  const focusReaderWhenShown = useCallback((threadKey: string) => {
    pending.current = { target: "reader", threadKey, reached: false };
  }, []);
  const focusListWhenShown = useCallback(() => {
    pending.current = { target: "list", threadKey: null, reached: false };
  }, []);

  return { listRef, readerRef, focusReaderWhenShown, focusListWhenShown };
}
