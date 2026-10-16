"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useId, useRef } from "react";
import { ChatPanelResizeHandle } from "@/components/ChatPanelResizeHandle";
import { useSidebar } from "@/components/ui/sidebar";
import { useIsLargeScreen } from "@/hooks/use-mobile";
import { useVisualViewportBox } from "@/hooks/useVisualViewportBox";
import { cn } from "@/utils";

const Chat = dynamic(
  () => import("@/components/assistant-chat/chat").then((mod) => mod.Chat),
  { ssr: false },
);

export function SidebarRight({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const { isOpen, close, onPanelKeyDown } = useSidebarPanel(name);
  const coversPage = useSidebarRightCoversPage(name);
  const panelId = useId();
  const panelRef = useRef<HTMLDivElement | null>(null);
  const visualViewportBoxRef = useVisualViewportBox(coversPage);
  const setPanelRef = useCallback(
    (element: HTMLDivElement | null) => {
      panelRef.current = element;
      return visualViewportBoxRef(element);
    },
    [visualViewportBoxRef],
  );

  // Covering the page, the panel behaves as a dialog: what opened it is left
  // behind an inert page, so focus has to be carried in and brought back.
  useEffect(() => {
    if (!coversPage) return;
    const active = document.activeElement;
    const opener = active instanceof HTMLElement ? active : null;
    panelRef.current?.focus();

    return () => {
      const focused = document.activeElement;
      const focusLeftWithPanel =
        !focused ||
        focused === document.body ||
        panelRef.current?.contains(focused);
      if (focusLeftWithPanel && opener?.isConnected) opener.focus();
    };
  }, [coversPage]);

  return (
    <div
      id={panelId}
      ref={setPanelRef}
      {...(coversPage ? MODAL_PROPS : undefined)}
      onKeyDown={(event) => onPanelKeyDown(event.nativeEvent)}
      className={cn(
        "fixed right-0 top-0 z-50 h-dvh border-l bg-background outline-none transition-transform duration-200 ease-linear motion-reduce:transition-none",
        // iOS keeps `dvh` full height under the keyboard; only the visual
        // viewport shrinks, so size from it to keep the input above the keys.
        "max-lg:top-[var(--visual-viewport-top,0px)] max-lg:h-[var(--visual-viewport-height,100dvh)]",
        "w-full lg:w-[var(--chat-panel-width,450px)]",
        isOpen ? "translate-x-0" : "translate-x-full",
        className,
      )}
    >
      {/* Below lg the panel covers the screen, so there's nothing to resize. */}
      {isOpen ? (
        <ChatPanelResizeHandle panelId={panelId} className="hidden lg:block" />
      ) : null}
      <div className="flex h-full w-full flex-col overflow-hidden">
        {isOpen ? <Chat open onClose={close} /> : null}
      </div>
    </div>
  );
}

/**
 * Wraps the page beside the panel. Where the open panel covers the screen, the
 * page leaves the tab order and the accessibility tree, as it would behind any
 * dialog.
 */
export function BehindSidebarRight({
  name,
  disabled = false,
  children,
}: {
  name: string;
  /** No panel is rendered with this page, so nothing covers it. */
  disabled?: boolean;
  children: React.ReactNode;
}) {
  const coversPage = useSidebarRightCoversPage(name);

  return (
    <div className="contents" inert={!disabled && coversPage}>
      {children}
    </div>
  );
}

/** Below `lg` the open panel covers the whole screen. */
function useSidebarRightCoversPage(name: string) {
  const isOpen = useIsSidebarPanelOpen(name);
  const isLargeScreen = useIsLargeScreen();
  return isOpen && !isLargeScreen;
}

function useSidebarPanel(name: string) {
  const { setOpen, setOpenMobile } = useSidebar();
  const isOpen = useIsSidebarPanelOpen(name);
  const close = useCallback(() => {
    const removeSidebar = (openSidebars: string[]) =>
      openSidebars.filter((sidebarName) => sidebarName !== name);

    setOpen(removeSidebar);
    setOpenMobile(removeSidebar);
  }, [name, setOpen, setOpenMobile]);

  // React bubbles events from the panel's portaled menus and dialogs through
  // the panel too, so this sees every Escape that belongs to the chat.
  const panelEvent = useRef<KeyboardEvent | null>(null);
  const onPanelKeyDown = useCallback(
    (event: KeyboardEvent) => {
      panelEvent.current = event;
      // A menu or dialog inside the panel claims Escape for itself first.
      // Claiming it here, before the page's shortcuts on the document, keeps
      // mail's own Escape from also acting behind the chat.
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      close();
    },
    [close],
  );

  useEffect(() => {
    if (!isOpen) return;
    // Escape from the page beside the panel closes it too, whatever the page
    // did with the key.
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event === panelEvent.current) return;
      close();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, isOpen]);

  return { close, isOpen, onPanelKeyDown };
}

function useIsSidebarPanelOpen(name: string) {
  const { state, openMobile, isMobile } = useSidebar();
  return isMobile ? openMobile.includes(name) : state.includes(name);
}

const MODAL_PROPS = {
  role: "dialog",
  "aria-modal": true,
  "aria-label": "Chat",
  tabIndex: -1,
} as const;
