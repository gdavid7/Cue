"use client";

import { createContext, type ReactNode, useContext, useState } from "react";
import type {
  DraggedConversation,
  SidebarDropAction,
} from "@/app/(app)/[emailAccountId]/mail/sidebar-drop";

/** Conversations being dragged from the mail list, and what a drop runs. */
export type MailDrag = {
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
