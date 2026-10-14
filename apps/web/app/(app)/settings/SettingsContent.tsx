"use client";

import Link from "next/link";
import type { MouseEvent } from "react";
import { useCallback, useMemo, useState } from "react";
import {
  ChevronRightIcon,
  MessageCircleIcon,
  MessagesSquareIcon,
  PlugIcon,
  PlusIcon,
  SendIcon,
} from "lucide-react";
import { ApiKeysSection } from "@/app/(app)/[emailAccountId]/settings/ApiKeysSection";
import { McpSection } from "@/app/(app)/[emailAccountId]/settings/McpSection";
import { EmailOtpSection } from "@/app/(app)/settings/EmailOtpSection";
import { AppearanceSection } from "@/app/(app)/settings/AppearanceSection";
import { BillingSection } from "@/app/(app)/[emailAccountId]/settings/BillingSection";
import { CleanupDraftsSection } from "@/app/(app)/[emailAccountId]/settings/CleanupDraftsSection";
import { SentMessageOpenTrackingSetting } from "@/app/(app)/[emailAccountId]/settings/SentMessageOpenTrackingSetting";
import { VacationResponderSetting } from "@/app/(app)/[emailAccountId]/settings/VacationResponderSetting";
import { useSlackNotifications } from "@/app/(app)/[emailAccountId]/settings/ConnectedAppsSection";
import { DeleteSection } from "@/app/(app)/[emailAccountId]/settings/DeleteSection";
import { OrgAnalyticsConsentSection } from "@/app/(app)/[emailAccountId]/settings/OrgAnalyticsConsentSection";
import { ResetAnalyticsSection } from "@/app/(app)/[emailAccountId]/settings/ResetAnalyticsSection";
import { CopyRulesSection } from "@/app/(app)/[emailAccountId]/settings/CopyRulesSection";
import { RuleImportExportSetting } from "@/app/(app)/[emailAccountId]/assistant/settings/RuleImportExportSetting";
import { ToggleAllRulesSection } from "@/app/(app)/[emailAccountId]/settings/ToggleAllRulesSection";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { CueLabelsSetting } from "@/components/CueLabelsCleanup";
import { LoadingContent } from "@/components/LoadingContent";
import { SectionHeader } from "@/components/Typography";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Item,
  ItemActions,
  ItemCard,
  ItemContent,
  ItemDescription,
  ItemSeparator,
  ItemTitle,
} from "@/components/ui/item";
import { useAccounts } from "@/hooks/useAccounts";
import { useMessagingChannels } from "@/hooks/useMessagingChannels";
import { usePremium } from "@/hooks/usePremium";
import { useAccount } from "@/providers/EmailAccountProvider";
import { cn } from "@/utils";
import { prefixPath } from "@/utils/path";
import { logOut } from "@/utils/user";
import { env } from "@/env";

export function SettingsContent() {
  const { emailAccountId: activeEmailAccountId } = useAccount();
  const { data, isLoading, error } = useAccounts();
  const { canManageBilling } = usePremium();
  // Undefined until the user toggles a card: the current account starts open.
  const [toggledAccountId, setExpandedAccountId] = useState<
    string | null | undefined
  >(undefined);
  const expandedAccountId =
    toggledAccountId === undefined
      ? activeEmailAccountId || null
      : toggledAccountId;

  const handleSlackConnected = useCallback(
    (connectedEmailAccountId: string | null) => {
      setExpandedAccountId(
        connectedEmailAccountId ?? activeEmailAccountId ?? null,
      );
    },
    [activeEmailAccountId],
  );

  useSlackNotifications({
    enabled: true,
    onSlackConnected: handleSlackConnected,
  });

  const emailAccounts = useMemo(() => {
    const accounts = data?.emailAccounts ?? [];
    return [...accounts].sort((a, b) => {
      if (a.id === activeEmailAccountId) return -1;
      if (b.id === activeEmailAccountId) return 1;
      return 0;
    });
  }, [activeEmailAccountId, data?.emailAccounts]);

  return (
    <div className="space-y-10">
      <SettingsGroup title="Email accounts">
        <LoadingContent loading={isLoading} error={error}>
          {emailAccounts.length > 0 && (
            <div className="space-y-4">
              {emailAccounts.map((emailAccount) => (
                <EmailAccountSettingsCard
                  key={emailAccount.id}
                  emailAccount={emailAccount}
                  allAccounts={emailAccounts}
                  isCurrent={emailAccount.id === activeEmailAccountId}
                  expanded={expandedAccountId === emailAccount.id}
                  onToggle={() =>
                    setExpandedAccountId(
                      expandedAccountId === emailAccount.id
                        ? null
                        : emailAccount.id,
                    )
                  }
                />
              ))}

              <Button asChild variant="outline">
                <Link href="/accounts">
                  <PlusIcon className="mr-2 size-4" />
                  Add account
                </Link>
              </Button>
            </div>
          )}
        </LoadingContent>
      </SettingsGroup>

      {!env.NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS && canManageBilling && (
        <SettingsGroup title="Billing">
          <ItemCard>
            <BillingSection />
          </ItemCard>
        </SettingsGroup>
      )}

      <SettingsGroup title="Account">
        <ItemCard>
          {env.NEXT_PUBLIC_EXTERNAL_API_ENABLED && <McpSection />}
          <EmailOtpSection hasMultipleAccounts={emailAccounts.length > 1} />
          <ItemSeparator />
          <AppearanceSection />
          {activeEmailAccountId && (
            <>
              <ItemSeparator />
              <Item size="sm" asChild>
                <Link
                  href={prefixPath(
                    activeEmailAccountId,
                    "/automation?tab=settings",
                  )}
                >
                  <ItemContent>
                    <ItemTitle>Email &amp; AI preferences</ItemTitle>
                    <ItemDescription>
                      Signature, snippets and writing style
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRightIcon className="size-4 text-muted-foreground" />
                  </ItemActions>
                </Link>
              </Item>
            </>
          )}
        </ItemCard>
        <ItemCard>
          <Item size="sm">
            <ItemContent>
              <ItemTitle>Sign out</ItemTitle>
            </ItemContent>
            <ItemActions>
              <Button
                variant="outline"
                size="sm"
                onClick={() => logOut(window.location.origin)}
              >
                Sign out
              </Button>
            </ItemActions>
          </Item>
          <ItemSeparator />
          <DeleteSection />
        </ItemCard>
      </SettingsGroup>

      {env.NEXT_PUBLIC_EXTERNAL_API_ENABLED && (
        <SettingsGroup title="Developer">
          <ItemCard>
            <ApiKeysSection />
          </ItemCard>
        </SettingsGroup>
      )}
    </div>
  );
}

function EmailAccountSettingsCard({
  emailAccount,
  allAccounts,
  isCurrent,
  expanded,
  onToggle,
}: {
  emailAccount: GetEmailAccountsResponse["emailAccounts"][number];
  allAccounts: GetEmailAccountsResponse["emailAccounts"];
  isCurrent: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { data: channelsData } = useMessagingChannels(emailAccount.id);

  const connectedProviders = Array.from(
    new Set(
      channelsData?.channels
        .filter((ch) => ch.isConnected)
        .map((ch) => ch.provider) ?? [],
    ),
  );
  const hasUnconnectedProvider = channelsData?.availableProviders?.some(
    (p) => !connectedProviders.includes(p),
  );

  return (
    <ItemCard>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        className="flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
        onClick={onToggle}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onToggle();
          }
        }}
      >
        <Avatar className="size-8 rounded-full">
          <AvatarImage
            src={emailAccount.image || ""}
            alt={emailAccount.name || emailAccount.email}
          />
          <AvatarFallback className="rounded-full text-xs">
            {emailAccount.name?.charAt(0) || emailAccount.email?.charAt(0)}
          </AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 truncate text-sm font-medium">
          {emailAccount.email}
        </span>
        {isCurrent && (
          <Badge variant="secondary" className="text-xs font-normal">
            Current
          </Badge>
        )}
        {connectedProviders.map((provider) => (
          <Badge
            key={provider}
            variant="secondary"
            className="gap-1 text-xs font-normal"
          >
            <ProviderIcon provider={provider} className="size-3" />
            {PROVIDER_LABELS[provider] ?? provider}
          </Badge>
        ))}
        {hasUnconnectedProvider && (
          <Link
            href={`/${emailAccount.id}/channels`}
            onClick={(e: MouseEvent<HTMLAnchorElement>) => e.stopPropagation()}
          >
            <Badge
              variant="outline"
              className="gap-1 text-xs font-normal cursor-pointer hover:bg-muted"
            >
              <PlugIcon className="size-3" />
              Slack &amp; Teams
            </Badge>
          </Link>
        )}
        <ChevronRightIcon
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            expanded && "rotate-90",
          )}
        />
      </div>

      {expanded && (
        <>
          <SentMessageOpenTrackingSetting emailAccountId={emailAccount.id} />
          <VacationResponderSetting
            emailAccountId={emailAccount.id}
            provider={emailAccount.account.provider}
          />
          <OrgAnalyticsConsentSection emailAccountId={emailAccount.id} />
          <ToggleAllRulesSection emailAccountId={emailAccount.id} />
          <RuleImportExportSetting emailAccountId={emailAccount.id} />
          <CopyRulesSection
            emailAccountId={emailAccount.id}
            emailAccountEmail={emailAccount.email}
            allAccounts={allAccounts}
          />
          <CleanupDraftsSection emailAccountId={emailAccount.id} />
          <CueLabelsSetting
            emailAccountId={emailAccount.id}
            provider={emailAccount.account.provider}
          />
          <ResetAnalyticsSection emailAccountId={emailAccount.id} />
        </>
      )}
    </ItemCard>
  );
}

const PROVIDER_LABELS: Record<string, string> = {
  SLACK: "Slack",
  TEAMS: "Teams",
  TELEGRAM: "Telegram",
};

function ProviderIcon({
  provider,
  className,
}: {
  provider: string;
  className?: string;
}) {
  switch (provider) {
    case "SLACK":
      return <MessagesSquareIcon className={className} />;
    case "TEAMS":
      return <MessageCircleIcon className={className} />;
    case "TELEGRAM":
      return <SendIcon className={className} />;
    default:
      return <PlugIcon className={className} />;
  }
}

function SettingsGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="space-y-4">
      <SectionHeader>{title}</SectionHeader>
      {children}
    </section>
  );
}
