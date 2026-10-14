"use client";

import { useMemo } from "react";
import { useNavigation } from "@/components/SideNav";

/**
 * The app's main places beyond the mailbox and Today, named as the app's own
 * navigation names them. The mail screen hides that navigation, so it lists
 * these itself.
 */
export function useMailAppLinks() {
  const { manageItems } = useNavigation();

  return useMemo(
    () =>
      manageItems
        .filter(
          (item) =>
            !item.href.endsWith("/mail") && !item.href.endsWith("/home"),
        )
        .map((item) => ({
          name: item.name,
          href: item.href,
          icon: (
            <span className="flex shrink-0 [&>svg]:size-4">
              <item.icon />
            </span>
          ),
        })),
    [manageItems],
  );
}
