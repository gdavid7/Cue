"use client";

import { usePathname } from "next/navigation";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { SideNav } from "@/components/SideNav";
import { SidebarRight } from "@/components/SidebarRight";
import {
  useChatPanelWidth,
  useIsResizingChatPanel,
} from "@/hooks/useChatPanelWidth";
import { cn } from "@/utils";
import { isMailShellPath } from "@/utils/path";

function ContentWrapper({ children }: { children: React.ReactNode }) {
  const { state } = useSidebar();
  const pathname = usePathname();
  const isAssistantRoute = pathname?.includes("/assistant");
  const isMailRoute = pathname ? isMailShellPath(pathname) : false;
  const isRightSidebarOpen =
    !isAssistantRoute && state.includes("chat-sidebar");

  // The padding only exists to clear the fixed MobileHeader. Mail and the
  // chat page render none; the rule editor pages under /assistant need the
  // padding like any other page.
  const isChatPage = isChatPagePath(pathname);
  const noTopPadding = isChatPage || isMailRoute;

  return (
    <div
      className={cn(
        "min-w-0 flex-1 transition-all duration-200 ease-linear motion-reduce:transition-none",
        isRightSidebarOpen && "lg:mr-[var(--chat-panel-width)]",
      )}
    >
      <SidebarInset
        className={cn(
          // clip, not hidden: hidden makes this a scroll container, which
          // stops sticky descendants from sticking to the page scroll
          "overflow-clip bg-background max-w-full",
          !noTopPadding && "pt-10 md:pt-0",
          // The mail page fills the viewport and scrolls its thread list
          // internally, so layout banners shrink it instead of overflowing
          isMailRoute && "h-svh",
          // Chat pins its input to the bottom and scrolls the conversation
          // above it, so it fills what the banners leave, too.
          isChatPage && "h-dvh",
        )}
        // Mail's own sidebar is fixed over the left edge, so layout banners
        // above the mail screen indent by its width to stay readable.
        style={
          isMailRoute
            ? ({
                "--mail-rail-width": state.includes("left-sidebar")
                  ? "var(--sidebar-width)"
                  : "var(--sidebar-width-icon)",
              } as React.CSSProperties)
            : undefined
        }
      >
        {children}
      </SidebarInset>
    </div>
  );
}

export function SideNavWithTopNav({
  children,
  defaultOpen,
  feedbackEnabled,
}: {
  children: React.ReactNode;
  defaultOpen: boolean;
  feedbackEnabled: boolean;
}) {
  const pathname = usePathname();
  const chatPanelWidth = useChatPanelWidth();
  const isResizingChatPanel = useIsResizingChatPanel();

  if (!pathname) return null;

  const isAssistantRoute = pathname.includes("/assistant");
  // The mail screen ships its own sidebar, so this one would be a second copy.
  const isMailRoute = isMailShellPath(pathname);

  // The meeting briefs onboarding (/[emailAccountId]/onboarding-brief) is full screen.
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 2 && segments[1] === "onboarding-brief")
    return children;

  return (
    <SidebarProvider
      defaultOpen={defaultOpen ? ["left-sidebar"] : []}
      sidebarNames={["left-sidebar", "chat-sidebar"]}
      keyboardShortcutName="left-sidebar"
      style={
        { "--chat-panel-width": `${chatPanelWidth}px` } as React.CSSProperties
      }
      // While dragging, the panel and the content beside it track the pointer
      // with no easing, and email iframes can't swallow the pointer.
      data-chat-panel-resizing={isResizingChatPanel || undefined}
      className="data-[chat-panel-resizing]:select-none data-[chat-panel-resizing]:[&_*]:!cursor-col-resize data-[chat-panel-resizing]:[&_*]:!transition-none data-[chat-panel-resizing]:[&_iframe]:pointer-events-none"
    >
      {/* Mail supplies its own sidebar and trigger for this shared state, so
          the global navigation and its mobile header would be duplicates.
          The chat page puts the trigger in its own top bar, where a layout
          banner above it can't end up underneath a fixed one. */}
      {!isMailRoute && (
        <>
          {!isChatPagePath(pathname) && <MobileHeader />}
          <SideNav name="left-sidebar" feedbackEnabled={feedbackEnabled} />
        </>
      )}
      <ContentWrapper>{children}</ContentWrapper>
      {!isAssistantRoute ? <SidebarRight name="chat-sidebar" /> : null}
    </SidebarProvider>
  );
}

function MobileHeader() {
  return (
    <header className="pointer-events-none fixed top-0 left-0 right-0 z-50 h-10 md:hidden">
      <div className="flex h-full items-center px-2">
        <SidebarTrigger
          name="left-sidebar"
          className="pointer-events-auto size-10"
        />
      </div>
    </header>
  );
}

function isChatPagePath(pathname: string | null) {
  return pathname?.split("/").filter(Boolean).at(-1) === "assistant";
}
