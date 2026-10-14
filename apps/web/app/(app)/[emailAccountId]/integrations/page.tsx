"use client";

import { ListChecksIcon, PenLineIcon } from "lucide-react";
import { PageWrapper } from "@/components/PageWrapper";
import { PageHeader } from "@/components/PageHeader";
import { Integrations } from "@/app/(app)/[emailAccountId]/integrations/Integrations";
import { FeatureIcon } from "@/components/FeatureIcon";
import {
  Item,
  ItemCard,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item";
import { cn } from "@/utils";
import { AddCustomMcpServerDialog } from "./AddCustomMcpServerDialog";
import { usePremium } from "@/hooks/usePremium";
import { hasTierAccess } from "@/utils/premium";
import { IntegrationsPremiumAlert } from "./IntegrationsPremiumAlert";
import { useIntegrationActionsEnabled } from "@/hooks/useFeatureFlags";

export default function IntegrationsPage() {
  const { tier, isLoading: isPremiumLoading } = usePremium();

  const hasAccess = hasTierAccess({
    tier: tier || null,
    minimumTier: "PLUS_MONTHLY",
  });

  return (
    <PageWrapper>
      <div className="flex flex-col items-start gap-2 sm:flex-row sm:items-center sm:justify-between">
        <PageHeader
          title="Integrations"
          description="Connect the tools you already use."
        />
      </div>

      <div className="mt-8 space-y-4">
        {!isPremiumLoading && !hasAccess && <IntegrationsPremiumAlert />}
        <Capabilities />
        <Integrations />
        {hasAccess && (
          <div className="flex items-center justify-between gap-2 text-muted-foreground text-sm">
            <span>Have your own MCP server? Connect it directly.</span>
            <AddCustomMcpServerDialog />
          </div>
        )}
      </div>
    </PageWrapper>
  );
}

function Capabilities() {
  const actionsEnabled = useIntegrationActionsEnabled();

  return (
    <ItemCard className={cn(actionsEnabled && "sm:grid sm:grid-cols-2")}>
      <Item>
        <ItemMedia>
          <FeatureIcon>
            <PenLineIcon className="h-4 w-4" />
          </FeatureIcon>
        </ItemMedia>
        <ItemContent>
          <ItemTitle>Context from your apps</ItemTitle>
          <ItemDescription>
            Files, messages, and deadlines from the apps you connect appear next
            to the emails they relate to, and back the replies Cue suggests.
          </ItemDescription>
        </ItemContent>
      </Item>
      {actionsEnabled && (
        <Item>
          <ItemMedia>
            <FeatureIcon>
              <ListChecksIcon className="h-4 w-4" />
            </FeatureIcon>
          </ItemMedia>
          <ItemContent>
            <ItemTitle>Rule actions</ItemTitle>
            <ItemDescription>
              Rules can write back, like adding a Todoist task.
            </ItemDescription>
          </ItemContent>
        </Item>
      )}
    </ItemCard>
  );
}
