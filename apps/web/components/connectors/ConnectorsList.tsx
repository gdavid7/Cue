"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { ConnectorLogo } from "@/components/connectors/ConnectorLogo";
import { useIntegrations } from "@/hooks/useIntegrations";
import { cn } from "@/utils";
import { prefixPath } from "@/utils/path";

/**
 * The apps Cue reads alongside your email, in the order a student reaches for
 * them. All come through Composio; an app not listed there isn't supported.
 */
export const CONNECTORS: {
  name: string;
  displayName: string;
  domain: string;
}[] = [
  {
    name: "googledrive",
    displayName: "Google Drive",
    domain: "drive.google.com",
  },
  { name: "one_drive", displayName: "OneDrive", domain: "onedrive.live.com" },
  {
    name: "microsoft_teams",
    displayName: "Teams",
    domain: "teams.microsoft.com",
  },
  { name: "canvas", displayName: "Canvas", domain: "instructure.com" },
  { name: "slack", displayName: "Slack", domain: "slack.com" },
];

/**
 * Connected apps in the sidebar, each linking to Integrations. With none
 * connected it's a single row that leads there to connect one.
 */
export function ConnectorsList({
  emailAccountId,
  collapsed = false,
}: {
  emailAccountId: string;
  /** Icon-only sidebar rail. */
  collapsed?: boolean;
}) {
  const { data } = useIntegrations();
  // Rendered only once known, so rows never flash one status, then another.
  if (!data) return null;

  const integrationsHref = prefixPath(emailAccountId, "/integrations");
  const connected = new Map(
    data.integrations
      .filter((integration) => integration.connection)
      .map((integration) => [integration.name, integration]),
  );
  const connectedApps = CONNECTORS.filter((connector) =>
    connected.has(connector.name),
  );
  const rowClassName = cn(
    "flex items-center gap-2 rounded-md py-1.5 text-left text-sm hover:bg-muted/60",
    collapsed ? "justify-center px-0" : "px-2.5",
  );

  return (
    <nav aria-label="Connectors" className="flex flex-col gap-px">
      {connectedApps.map((connector) => {
        const via = connected.get(connector.name)?.connection?.connectedVia;
        const label = `${connector.displayName}: connected${via ? ` via ${via}` : ""}`;
        return (
          <Link
            className={cn(rowClassName, "text-foreground")}
            href={integrationsHref}
            key={connector.name}
            title={collapsed || via ? label : undefined}
          >
            <ConnectorLogo
              domain={connector.domain}
              logo={`/images/connectors/${connector.name}.svg`}
              size={16}
            />
            {collapsed ? (
              <span className="sr-only">{label}</span>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate">
                  {connector.displayName}
                </span>
                <span className="size-2 shrink-0 rounded-full bg-emerald-500">
                  <span className="sr-only">Connected</span>
                </span>
              </>
            )}
          </Link>
        );
      })}
      <Link
        className={cn(rowClassName, "text-muted-foreground")}
        href={integrationsHref}
        title={collapsed ? "Connect your apps" : undefined}
      >
        <PlusIcon className="size-4 shrink-0" />
        {collapsed ? (
          <span className="sr-only">Connect your apps</span>
        ) : connectedApps.length ? (
          "More connectors"
        ) : (
          "Connect your apps"
        )}
      </Link>
    </nav>
  );
}
