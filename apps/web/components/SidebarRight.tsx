"use client";

import dynamic from "next/dynamic";
import { memo, useCallback, useEffect } from "react";
import { ChatPanelResizeHandle } from "@/components/ChatPanelResizeHandle";
import { useSidebar } from "@/components/ui/sidebar";
import { cn } from "@/utils";

const Chat = dynamic(
  () => import("@/components/assistant-chat/chat").then((mod) => mod.Chat),
  { ssr: false },
);

// Memoized so a drag, which re-renders the layout on every pointer move,
// doesn't re-render the conversation as well.
export const SidebarRight = memo(function SidebarRight({
  name,
  className,
}: {
  name: string;
  className?: string;
}) {
  const { isOpen, close } = useSidebarPanel(name);

  return (
    <div
      className={cn(
        "fixed right-0 top-0 z-50 h-dvh border-l bg-background transition-transform duration-200 ease-linear motion-reduce:transition-none",
        "w-full lg:w-[var(--chat-panel-width)]",
        isOpen ? "translate-x-0" : "translate-x-full",
        className,
      )}
    >
      {/* Below lg the panel covers the screen, so there's nothing to resize. */}
      {isOpen ? <ChatPanelResizeHandle className="hidden lg:block" /> : null}
      <div className="flex h-full w-full flex-col overflow-hidden">
        {isOpen ? <Chat open onClose={close} /> : null}
      </div>
    </div>
  );
});

function useSidebarPanel(name: string) {
  const { state, openMobile, isMobile, setOpen, setOpenMobile } = useSidebar();
  const isOpen = isMobile ? openMobile.includes(name) : state.includes(name);
  const close = useCallback(() => {
    const removeSidebar = (openSidebars: string[]) =>
      openSidebars.filter((sidebarName) => sidebarName !== name);

    setOpen(removeSidebar);
    setOpenMobile(removeSidebar);
  }, [name, setOpen, setOpenMobile]);

  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close();
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [close, isOpen]);

  return { close, isOpen };
}
