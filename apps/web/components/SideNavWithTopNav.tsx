"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";
import { usePathname } from "next/navigation";
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "@/components/ui/sidebar";
import { SideNav } from "@/components/SideNav";
import { SidebarRight } from "@/components/SidebarRight";
import { cn } from "@/utils";
import { isMailShellPath } from "@/utils/path";

const CrispWithNoSSR = dynamic(() => import("@/components/CrispChat"));

function ContentWrapper({ children }: { children: React.ReactNode }) {
  const { state } = useSidebar();
  const pathname = usePathname();
  const isAssistantRoute = pathname?.includes("/assistant");
  const isMailRoute = pathname ? isMailShellPath(pathname) : false;
  const isRightSidebarOpen =
    !isAssistantRoute && state.includes("chat-sidebar");

  // The padding only exists to clear the fixed MobileHeader. Mail renders no
  // MobileHeader, and the chat page lays out its own header around it; the
  // rule editor pages under /assistant need the padding like any other page.
  const isChatRoute =
    pathname?.split("/").filter(Boolean).at(-1) === "assistant";
  const noTopPadding = isChatRoute || isMailRoute;

  return (
    <div
      className={cn(
        "min-w-0 flex-1 transition-all duration-200 ease-linear",
        isRightSidebarOpen && "lg:mr-[450px]",
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
      <Suspense>
        <CrispWithNoSSR />
      </Suspense>
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
    >
      {/* Mail supplies its own sidebar and trigger for this shared state, so
          the global navigation and its mobile header would be duplicates. */}
      {!isMailRoute && (
        <>
          <MobileHeader />
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
