"use client";

import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import type {
  DraggedConversation,
  SidebarDropAction,
} from "@/app/(app)/[emailAccountId]/mail/sidebar-drop";

/** Conversations being dragged from the mail list, and what a drop runs. */
export type MailDrag = {
  /** Written to the drag's data, so only this drag's drop acts on it. */
  nonce: string;
  conversations: DraggedConversation[];
  /** Runs the resolved action on the dragged conversations. */
  onDrop: (action: SidebarDropAction) => void;
};

const MailDragContext = createContext<MailDrag | null>(null);
// Kept apart so the list, which only starts and ends drags, doesn't re-render
// as one begins.
const SetMailDragContext = createContext<(drag: MailDrag | null) => void>(
  () => {},
);

/**
 * Shared by the mail list and the sidebar, which sit in different parts of
 * the mail frame. Lives only in this tab's memory.
 */
export function MailDragProvider({ children }: { children: ReactNode }) {
  const [drag, setDrag] = useState<MailDrag | null>(null);
  // A row removed mid-drag never gets its dragend. The pointer reports moves
  // and presses only once no drag is running, so either means it is over.
  useEffect(() => {
    if (!drag) return;
    const clear = () => setDrag(null);
    const events = ["pointerdown", "mousemove", "dragend"] as const;
    for (const type of events) document.addEventListener(type, clear, true);
    return () => {
      for (const type of events)
        document.removeEventListener(type, clear, true);
    };
  }, [drag]);
  return (
    <SetMailDragContext.Provider value={setDrag}>
      <MailDragContext.Provider value={drag}>
        {children}
      </MailDragContext.Provider>
    </SetMailDragContext.Provider>
  );
}

export function useMailDrag() {
  return useContext(MailDragContext);
}

export function useSetMailDrag() {
  return useContext(SetMailDragContext);
}

/** The custom type keeps the drag from dropping as text into inputs. */
export const MAIL_DRAG_TYPE = "application/x-cue-conversations";

/** Mail dragged from a mail list, rather than a file, text or a link. */
export function isMailDragEvent(dataTransfer: DataTransfer) {
  return Array.from(dataTransfer.types).includes(MAIL_DRAG_TYPE);
}

/**
 * Whether the pointer is inside an element during a drag. Counts enters and
 * leaves, since moving onto a child fires both and WebKit leaves out the
 * related target; a dragover while uncounted re-enters, so a lost event
 * can't leave the element unhovered.
 */
export function useDragPresence(
  /** The drag being counted; a new one starts from zero. */
  drag: MailDrag | null,
  onChange: (present: boolean) => void,
) {
  const counted = useRef<{ drag: MailDrag | null; depth: number }>({
    drag: null,
    depth: 0,
  });
  const current = () => {
    if (counted.current.drag !== drag) counted.current = { drag, depth: 0 };
    return counted.current;
  };
  return {
    enter() {
      const state = current();
      state.depth += 1;
      if (state.depth === 1) onChange(true);
    },
    over() {
      const state = current();
      if (state.depth > 0) return;
      state.depth = 1;
      onChange(true);
    },
    leave() {
      const state = current();
      if (state.depth === 0) return;
      state.depth -= 1;
      if (state.depth === 0) onChange(false);
    },
    reset() {
      current().depth = 0;
    },
  };
}

/**
 * A compact count follows the pointer instead of a picture of the row. It
 * must be in the document when the browser snapshots it, then goes.
 */
export function setConversationDragImage(
  dataTransfer: DataTransfer,
  count: number,
) {
  const preview = document.createElement("div");
  preview.textContent =
    count === 1 ? "1 conversation" : `${count} conversations`;
  preview.className =
    "fixed -top-[200px] left-0 whitespace-nowrap rounded-lg bg-primary px-3 py-1.5 font-medium text-primary-foreground text-sm shadow-md";
  document.body.append(preview);
  dataTransfer.setDragImage(preview, -12, -12);
  setTimeout(() => preview.remove(), 0);
}
