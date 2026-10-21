"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import {
  LogOutIcon,
  BarChartBigIcon,
  SettingsIcon,
  SlidersHorizontalIcon,
  UserIcon,
  ScrollTextIcon,
  UsersIcon,
  ShieldCheckIcon,
} from "lucide-react";
import type { Command } from "@/lib/commands/types";
import { useNavigation } from "@/components/SideNav";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { useRules } from "@/hooks/useRules";
import { useAllAccountsScope } from "@/hooks/useTodayHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { prefixPath } from "@/utils/path";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { logOut } from "@/utils/user";

/**
 * The palette's places and settings. Navigation comes from `useNavigation`,
 * the same list the sidebars draw, so the three can't drift apart.
 */
export function useCommandPaletteCommands({
  includeRules = true,
}: {
  /** Off while mail actions lead the palette: rules would bury them. */
  includeRules?: boolean;
} = {}) {
  const router = useRouter();
  const { openSettings } = useSettingsDialog();
  const { emailAccountId, emailAccount, provider } = useAccount();
  // Across accounts, the open account's own pages and rules say whose they are.
  const account = useAllAccountsScope() ? emailAccount?.email : undefined;
  const { manageItems, toolsItems } = useNavigation();
  const { data: rulesData, isLoading: rulesLoading } = useRules(
    undefined,
    includeRules,
  );

  const commands = useMemo<Command[]>(() => {
    const navigationItems = [
      ...manageItems,
      ...toolsItems,
      // Lives in the account menu rather than the sidebar, for the provider
      // whose rule it wraps.
      ...(isGoogleProvider(provider)
        ? [
            {
              name: "Cold Email Blocker",
              href: prefixPath(emailAccountId, "/cold-email-blocker"),
              account,
              icon: ShieldCheckIcon,
              keywords: ["block", "cold", "spam", "filter"],
            },
          ]
        : []),
    ];
    const navigationCommands: Command[] = navigationItems.map(
      (item, index) => ({
        id: `nav-${item.name.toLowerCase().replace(/[^a-z]+/g, "-")}`,
        label: `Go to ${item.name}`,
        account: item.account,
        icon: item.icon,
        section: "navigation",
        priority: index + 10,
        keywords: [item.name.toLowerCase(), ...(item.keywords ?? [])],
        action: () => router.push(item.href),
      }),
    );

    const settingsCommands: Command[] = [
      {
        id: "settings-general",
        label: "Settings",
        description: "General account settings",
        icon: SettingsIcon,
        section: "settings",
        priority: 1,
        keywords: ["settings", "preferences", "configuration"],
        action: () => {
          openSettings();
        },
      },
      {
        id: "settings-rules",
        label: "Rules settings",
        description: "Signature, snippets and writing style",
        account,
        icon: SlidersHorizontalIcon,
        section: "settings",
        priority: 2,
        keywords: [
          "ai",
          "assistant",
          "automation",
          "signature",
          "snippets",
          "writing style",
        ],
        action: () =>
          router.push(prefixPath(emailAccountId, "/automation?tab=settings")),
      },
      {
        id: "settings-usage",
        label: "Usage",
        description: "View usage statistics",
        account,
        icon: BarChartBigIcon,
        section: "settings",
        priority: 3,
        keywords: ["usage", "stats", "limits"],
        action: () => router.push(prefixPath(emailAccountId, "/usage")),
      },
      {
        id: "settings-organization",
        label: "Organization",
        description: "Manage organization settings",
        icon: UsersIcon,
        section: "settings",
        priority: 4,
        keywords: ["org", "team", "organization"],
        action: () => router.push(prefixPath(emailAccountId, "/organization")),
      },
      {
        id: "manage-accounts",
        label: "Manage Accounts",
        description: "Add or switch email accounts",
        icon: UserIcon,
        section: "settings",
        priority: 5,
        keywords: ["accounts", "email", "switch"],
        action: () => router.push("/accounts"),
      },
      {
        id: "sign-out",
        label: "Sign out",
        icon: LogOutIcon,
        section: "settings",
        priority: 6,
        keywords: ["log out", "logout", "sign out", "exit"],
        action: () => logOut(),
      },
    ];

    const ruleCommands: Command[] = includeRules
      ? (rulesData ?? []).map((rule, index) => ({
          id: `rule-${rule.id}`,
          label: rule.name,
          description: rule.instructions || "View rule",
          account,
          icon: ScrollTextIcon,
          section: "rules" as const,
          priority: index + 1,
          keywords: ["rule", rule.name.toLowerCase()],
          action: () =>
            router.push(
              prefixPath(emailAccountId, `/assistant/rule/${rule.id}`),
            ),
        }))
      : [];

    return [...navigationCommands, ...settingsCommands, ...ruleCommands];
  }, [
    account,
    emailAccountId,
    includeRules,
    manageItems,
    openSettings,
    provider,
    router,
    rulesData,
    toolsItems,
  ]);

  return {
    commands,
    isLoading: includeRules && rulesLoading,
  };
}
