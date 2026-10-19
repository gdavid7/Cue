"use client";

import { useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import {
  BarChartBigIcon,
  BrushIcon,
  CalendarIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileTextIcon,
  HardDriveIcon,
  HashIcon,
  InboxIcon,
  type LucideIcon,
  MailsIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  MicIcon,
  SparklesIcon,
  SunIcon,
  ZapIcon,
} from "lucide-react";
import { ConnectorsList } from "@/components/connectors/ConnectorsList";
import { Logo } from "@/components/Logo";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroupLabel,
  SidebarGroup,
  SidebarHeader,
  SidebarGroupContent,
  SidebarMenuItem,
  SidebarMenu,
  useSidebar,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { SideNavMenu } from "@/components/SideNavMenu";
import { env } from "@/env";
import {
  useCleanerEnabled,
  useMeetingBriefsEnabled,
  useMeetingRecorderEnabled,
} from "@/hooks/useFeatureFlags";
import { useCurrentOrganization } from "@/hooks/useCurrentOrganization";
import { useMessagingChannels } from "@/hooks/useMessagingChannels";
import { useMailHref } from "@/hooks/useMailHref";
import { useAllAccountsScope, useTodayHref } from "@/hooks/useTodayHref";
import { useAccount } from "@/providers/EmailAccountProvider";
import { prefixPath } from "@/utils/path";
import { isGoogleProvider } from "@/utils/email/provider-types";
import { NavUser } from "@/components/NavUser";
import { PremiumCard } from "@/components/PremiumCard";
import { FeedbackSidebarButton } from "@/components/FeedbackDialog";

export type NavItem = {
  name: string;
  href: string;
  icon: LucideIcon;
  /** Extra words the command palette matches on. */
  keywords?: string[];
  target?: "_blank";
  count?: number;
  hideInMail?: boolean;
  active?: boolean;
  beta?: boolean;
  new?: boolean;
  /**
   * The account an account's own page opens, named while the user looks at
   * all their accounts together.
   */
  account?: string;
};

/**
 * The app's places, in one list. The app sidebar, the mail sidebar and the
 * command palette all read it, so a page added or renamed here shows up in
 * every one of them.
 */
export const useNavigation = () => {
  const showCleaner = useCleanerEnabled();
  const showMeetingBriefs = useMeetingBriefsEnabled();
  const showMeetingRecorder = useMeetingRecorderEnabled();
  const { emailAccount, emailAccountId, provider } = useAccount();
  const currentEmailAccountId = emailAccount?.id || emailAccountId;
  const allAccounts = useAllAccountsScope();
  const mailHref = useMailHref();
  const inboxHref = allAccounts
    ? mailHref({ allInboxes: true })
    : mailHref({ accountId: currentEmailAccountId });
  const todayHref = useTodayHref();
  const account = allAccounts ? emailAccount?.email : undefined;
  const { data: channelsData } = useMessagingChannels(
    currentEmailAccountId || null,
  );
  const showChannels = Boolean(channelsData?.availableProviders?.length);
  const isOrganizationMember = Boolean(useCurrentOrganization());

  const manageItems: NavItem[] = useMemo(
    () => [
      // The inbox comes first: every email, in order, with insights added.
      // Today is an optional briefing over it, not a replacement.
      {
        name: "Inbox",
        href: inboxHref,
        icon: InboxIcon,
        keywords: ["mail", "email"],
      },
      {
        name: "Today",
        href: todayHref,
        icon: SunIcon,
        keywords: ["home", "briefing", "dashboard"],
      },
      {
        name: "Chat",
        href: prefixPath(currentEmailAccountId, "/assistant"),
        account,
        icon: MessageSquareIcon,
        keywords: ["ask", "cue", "assistant", "ai"],
      },
      {
        name: "Rules",
        href: prefixPath(currentEmailAccountId, "/automation"),
        account,
        icon: SparklesIcon,
        keywords: ["ai", "automation", "auto"],
      },
      ...(showMeetingRecorder
        ? [
            {
              name: "Meetings",
              href: prefixPath(currentEmailAccountId, "/meetings"),
              account,
              icon: MicIcon,
              keywords: ["recorder", "notes"],
            },
          ]
        : []),
    ],
    [account, currentEmailAccountId, inboxHref, showMeetingRecorder, todayHref],
  );

  // Mailbox tools sit under Tools: Cue never archives in bulk on its own, so
  // these are for a user who goes looking.
  const toolsItems: NavItem[] = useMemo(
    () => [
      {
        name: "Calendars",
        href: prefixPath(currentEmailAccountId, "/calendars"),
        account,
        icon: CalendarIcon,
        keywords: ["calendar", "scheduling"],
      },
      ...(showMeetingBriefs
        ? [
            {
              name: "Meeting Briefs",
              href: prefixPath(currentEmailAccountId, "/briefs"),
              account,
              icon: FileTextIcon,
              keywords: ["briefs", "summaries"],
            },
          ]
        : []),
      ...(env.NEXT_PUBLIC_SMART_FILING_ENABLED === false
        ? []
        : [
            {
              name: "Attachments",
              href: prefixPath(currentEmailAccountId, "/drive"),
              account,
              icon: HardDriveIcon,
              keywords: ["drive", "files", "filing"],
              new: false,
            },
          ]),
      {
        name: "Integrations",
        href: prefixPath(currentEmailAccountId, "/integrations"),
        account,
        icon: ZapIcon,
        keywords: ["connectors", "apps", "connect"],
      },
      ...(showChannels
        ? [
            {
              name: "Slack & Teams",
              href: prefixPath(currentEmailAccountId, "/channels"),
              account,
              icon: HashIcon,
              keywords: ["slack", "teams", "channels", "notifications"],
            },
          ]
        : []),
      ...(isOrganizationMember
        ? [
            {
              name: "Shared",
              href: "/shared",
              icon: MessagesSquareIcon,
              keywords: ["team", "comments", "conversations"],
            },
          ]
        : []),
      {
        name: "Unsubscribe",
        href: prefixPath(currentEmailAccountId, "/bulk-unsubscribe"),
        account,
        icon: MailsIcon,
        keywords: ["bulk", "newsletters", "spam"],
      },
      {
        name: "Analytics",
        href: prefixPath(currentEmailAccountId, "/stats"),
        account,
        icon: BarChartBigIcon,
        keywords: ["statistics", "charts", "stats"],
      },
      ...(isGoogleProvider(provider) && showCleaner
        ? [
            {
              name: "Deep Clean",
              href: prefixPath(currentEmailAccountId, "/clean"),
              account,
              icon: BrushIcon,
              keywords: ["clean", "organize", "tidy"],
              beta: true,
            },
          ]
        : []),
    ],
    [
      account,
      currentEmailAccountId,
      isOrganizationMember,
      provider,
      showChannels,
      showCleaner,
      showMeetingBriefs,
    ],
  );

  return {
    homeHref: inboxHref,
    manageItems,
    toolsItems,
  };
};

export function SideNav({ ...props }: React.ComponentProps<typeof Sidebar>) {
  const navigation = useNavigation();
  const { emailAccount, emailAccountId } = useAccount();
  const currentEmailAccountId = emailAccount?.id || emailAccountId;
  const path = usePathname();
  const isToolActive = navigation.toolsItems.some(
    (item) => path === item.href || path.startsWith(`${item.href}/`),
  );
  const [showTools, setShowTools] = useState(isToolActive);
  // Opens the group when the page moves into it; otherwise the user's own
  // choice stays put.
  const [revealedForPath, setRevealedForPath] = useState(path);
  if (revealedForPath !== path) {
    setRevealedForPath(path);
    if (isToolActive) setShowTools(true);
  }

  const { state } = useSidebar();
  const isExpanded = state.includes("left-sidebar");

  return (
    <Sidebar collapsible="icon" {...props}>
      <SidebarHeader className="gap-0 pb-0">
        {isExpanded ? (
          <div className="flex items-center rounded-md pl-2 pr-0.5 py-3 text-foreground">
            <Link href={navigation.homeHref} data-hide-on-desktop-mac>
              <Logo className="h-5" />
            </Link>
            <SidebarTrigger name="left-sidebar" className="ml-auto" />
          </div>
        ) : (
          <div data-desktop-mac-titlebar-spacer className="pb-2">
            <SidebarTrigger name="left-sidebar" />
          </div>
        )}
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroupContent>
          <SidebarGroup>
            <SidebarGroupLabel>Manage</SidebarGroupLabel>
            <SideNavMenu items={navigation.manageItems} activeHref={path} />
          </SidebarGroup>
          {currentEmailAccountId ? (
            <ConnectedAppsGroup
              collapsed={!isExpanded}
              emailAccountId={currentEmailAccountId}
            />
          ) : null}
          <SidebarGroup>
            <SidebarGroupLabel asChild>
              <button
                type="button"
                className="w-full cursor-pointer justify-between gap-1"
                onClick={() => setShowTools((value) => !value)}
                aria-expanded={showTools}
              >
                <span>Tools</span>
                {showTools ? (
                  <ChevronDownIcon className="size-3.5" />
                ) : (
                  <ChevronRightIcon className="size-3.5" />
                )}
              </button>
            </SidebarGroupLabel>
            {showTools && (
              <SideNavMenu items={navigation.toolsItems} activeHref={path} />
            )}
          </SidebarGroup>
        </SidebarGroupContent>
      </SidebarContent>

      <PremiumCard isCollapsed={!isExpanded} />

      <SidebarFooter className="pb-4">
        <SidebarMenu>
          <SidebarMenuItem>
            <FeedbackSidebarButton />
          </SidebarMenuItem>
        </SidebarMenu>

        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}

function ConnectedAppsGroup({
  emailAccountId,
  collapsed,
}: {
  emailAccountId: string;
  collapsed: boolean;
}) {
  return (
    <SidebarGroup>
      <SidebarGroupLabel>Connectors</SidebarGroupLabel>
      <ConnectorsList collapsed={collapsed} emailAccountId={emailAccountId} />
    </SidebarGroup>
  );
}
