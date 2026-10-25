"use client";

import Link from "next/link";
import type { ComponentProps } from "react";
import type { LucideIcon } from "lucide-react";
import { usePathname } from "next/navigation";
import { posthog } from "@/utils/analytics/posthog-client";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { Badge } from "@/components/ui/badge";
import { useMailEngineStarting } from "@/utils/mail-engine/MailEngineHost";
import {
  getAppPageFromNavItem,
  getAppPageFromPathname,
  getAppPageProperties,
  PRODUCT_ANALYTICS_EVENTS,
  APP_PAGES,
} from "@/utils/analytics/product";

type NavItem = {
  name: string;
  href: string;
  icon: LucideIcon | ((props: ComponentProps<"svg">) => React.ReactNode);
  target?: "_blank";
  count?: number;
  hideInMail?: boolean;
  active?: boolean;
  disabled?: boolean;
  beta?: boolean;
  new?: boolean;
  account?: string;
};

export function SideNavMenu({
  items,
  activeHref,
}: {
  items: NavItem[];
  activeHref: string;
}) {
  const { closeMobileSidebar } = useSidebar();
  const pathname = usePathname();
  const currentAppPage = getAppPageFromPathname(pathname);
  // Other pages are fetched ahead only once the mail engine has started, so
  // they don't compete with its first load; Today keeps its own prefetch.
  const engineStarting = useMailEngineStarting();

  return (
    <SidebarMenu>
      {items.map((item) => (
        <SidebarMenuItem key={item.name} className="font-semibold">
          <SidebarMenuButton
            asChild
            isActive={item.active || activeHref === item.href}
            className="h-9"
            tooltip={item.name}
            sidebarName="left-sidebar"
          >
            {item.disabled ? (
              <span aria-disabled="true" className="cursor-default opacity-50">
                <item.icon />
                <span>{item.name}</span>
              </span>
            ) : (
              <Link
                href={item.href}
                prefetch={
                  engineStarting && !item.href.endsWith("/home")
                    ? false
                    : undefined
                }
                onClick={() => {
                  const destinationAppPage = getAppPageFromNavItem({
                    name: item.name,
                    href: item.href,
                  });

                  posthog.capture(PRODUCT_ANALYTICS_EVENTS.navigationClicked, {
                    ...getAppPageProperties(currentAppPage),
                    destination_page: destinationAppPage,
                    destination_page_label: destinationAppPage
                      ? APP_PAGES[destinationAppPage].label
                      : undefined,
                    nav_item: item.name,
                    nav_href_type: getNavHrefType(item.href),
                  });
                  closeMobileSidebar("left-sidebar");
                }}
              >
                <item.icon />
                <span>{item.name}</span>
                {item.account ? (
                  <span className="ml-auto min-w-0 truncate font-normal text-muted-foreground text-xs">
                    {item.account}
                  </span>
                ) : null}
                {item.new && (
                  <Badge variant="green" className="ml-auto text-[10px]">
                    New!
                  </Badge>
                )}
                {item.beta && (
                  <Badge variant="secondary" className="ml-auto text-[10px]">
                    Beta
                  </Badge>
                )}
              </Link>
            )}
          </SidebarMenuButton>
        </SidebarMenuItem>
      ))}
    </SidebarMenu>
  );
}

function getNavHrefType(href: string) {
  if (href.startsWith("?")) return "query";
  if (href.startsWith("http")) return "external";
  return "internal";
}
