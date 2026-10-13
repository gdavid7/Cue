"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { LoadingContent } from "@/components/LoadingContent";
import { TypographyP } from "@/components/Typography";
import {
  Table,
  TableRow,
  TableBody,
  TableCell,
  TableHeader,
  TableHead,
} from "@/components/ui/table";
import { useIntegrations } from "@/hooks/useIntegrations";
import type { GetIntegrationsResponse } from "@/app/api/mcp/integrations/route";
import { IntegrationRow } from "@/app/(app)/[emailAccountId]/integrations/IntegrationRow";
import { Card } from "@/components/ui/card";
import { toastError, toastInfo, toastSuccess } from "@/components/Toast";
import { useProductAnalytics } from "@/hooks/useProductAnalytics";
import { Button } from "@/components/ui/button";
import { CONNECTORS } from "@/components/connectors/ConnectorsList";

export function Integrations() {
  const { data, isLoading, error, mutate } = useIntegrations();
  const [showMore, setShowMore] = useState(false);

  useIntegrationNotifications(data?.integrations);

  const { featured, more } = splitIntegrations(data?.integrations ?? []);
  const rows = showMore ? [...featured, ...more] : featured;

  return (
    <Card>
      <LoadingContent loading={isLoading} error={error}>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Connection</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.length ? (
              rows.map((integration) => (
                <IntegrationRow
                  key={integration.name}
                  integration={integration}
                  onConnectionChange={mutate}
                />
              ))
            ) : (
              <TableRow>
                <TableCell colSpan={3}>
                  <TypographyP>No integrations found</TypographyP>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        {more.length ? (
          <div className="border-t p-2">
            <Button
              className="w-full"
              onClick={() => setShowMore((value) => !value)}
              size="sm"
              variant="ghost"
            >
              {showMore ? "Show fewer apps" : `Show ${more.length} more apps`}
            </Button>
          </div>
        ) : null}
      </LoadingContent>
    </Card>
  );
}

/**
 * The apps Cue reads for context come first, in the sidebar's order, with
 * anything already connected; the long tail of other apps waits behind a click.
 */
function splitIntegrations(
  integrations: GetIntegrationsResponse["integrations"],
) {
  const rank = (name: string) => {
    const index = CONNECTORS.findIndex((c) => c.name === name);
    return index === -1 ? CONNECTORS.length : index;
  };
  const isFeatured = (
    integration: GetIntegrationsResponse["integrations"][number],
  ) => !!integration.connection || rank(integration.name) < CONNECTORS.length;

  return {
    featured: integrations
      .filter(isFeatured)
      .sort((a, b) => rank(a.name) - rank(b.name)),
    more: integrations.filter((integration) => !isFeatured(integration)),
  };
}

function useIntegrationNotifications(
  integrations: GetIntegrationsResponse["integrations"] | undefined,
) {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();
  const analytics = useProductAnalytics("integrations");

  useEffect(() => {
    const connectedParam = searchParams.get("connected");
    const pendingParam = searchParams.get("pending");
    const errorParam = searchParams.get("error");
    if (!connectedParam && !pendingParam && !errorParam) return;

    if (errorParam) {
      const errorMessages: Record<
        string,
        { title: string; description: string }
      > = {
        cancelled: {
          title: "Connection cancelled",
          description:
            "You cancelled the authorization. Connect again whenever you're ready.",
        },
        oauth_error: {
          title: "Connection failed",
          description:
            "The service returned an authorization error. Please try again.",
        },
        connection_failed: {
          title: "Connection failed",
          description:
            "We couldn't complete the connection. Please try again or contact support.",
        },
        tool_sync_failed: {
          title: "Connected, but tools unavailable",
          description:
            "We couldn't load this integration's tools. Reconnect to try again.",
        },
        forbidden: {
          title: "Connection failed",
          description:
            "This account isn't authorized to complete the connection. Please try again.",
        },
      };

      const errorMessage = errorMessages[errorParam] || {
        title: "Connection failed",
        description:
          "We couldn't complete the connection. Please try again or contact support.",
      };

      toastError(errorMessage);
      analytics.captureAction("integration_connect_failed", {
        error_code: errorParam,
      });
    } else if (!integrations) {
      // The success toasts name the integration, so they wait for the list
      return;
    } else if (connectedParam) {
      const displayName = getDisplayName(connectedParam, integrations);
      toastSuccess({
        title: "Integration connected",
        description: `Connected to ${displayName}`,
      });
      analytics.captureAction("integration_connected", {
        integration: connectedParam,
      });
    } else if (pendingParam) {
      const displayName = getDisplayName(pendingParam, integrations);
      toastInfo({
        title: "Connection is still finishing",
        description: `We're still connecting to ${displayName}. Refresh in a moment to see the latest status.`,
      });
      analytics.captureAction("integration_connection_pending", {
        integration: pendingParam,
      });
    }

    router.replace(pathname);
  }, [analytics, integrations, pathname, router, searchParams]);
}

function getDisplayName(
  name: string,
  integrations: GetIntegrationsResponse["integrations"],
) {
  return (
    integrations.find((integration) => integration.name === name)
      ?.displayName || name
  );
}
