"use client";

import { useMemo } from "react";
import { type NavItem, useNavigation } from "@/components/SideNav";
import { isMailPath } from "@/utils/mail-url";

export type MailAppLink = { name: string; href: string; icon: React.ReactNode };

/**
 * The app's places beyond the mailbox and Today, read from the app's own
 * navigation so the mail screen, which hides that navigation, can't drift
 * from it. `toolLinks` are the rarer tools the app sidebar keeps under Tools.
 */
export function useMailAppLinks() {
  const { manageItems, toolsItems } = useNavigation();

  return useMemo(
    () => ({
      appLinks: manageItems
        .filter(
          (item) =>
            !isMailPath(item.href) &&
            !item.href.endsWith("/mail") &&
            !item.href.endsWith("/home"),
        )
        .map(toMailAppLink),
      toolLinks: toolsItems.map(toMailAppLink),
    }),
    [manageItems, toolsItems],
  );
}

function toMailAppLink(item: NavItem): MailAppLink {
  return {
    name: item.name,
    href: item.href,
    icon: (
      <span className="flex shrink-0 [&>svg]:size-4">
        <item.icon />
      </span>
    ),
  };
}
