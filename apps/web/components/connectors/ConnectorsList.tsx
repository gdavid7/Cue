"use client";

import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { startMcpOAuth } from "@/app/(app)/[emailAccountId]/integrations/startMcpOAuth";
import { ConnectorLogo } from "@/components/connectors/ConnectorLogo";
import { ConnectWithCredentialsDialog } from "@/components/connectors/ConnectWithCredentialsDialog";
import { toastError } from "@/components/Toast";
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
 * Connected apps in the sidebar: a dot for each that's connected, and one
 * click to connect the rest. Everything else lives on the Integrations page.
 */
export function ConnectorsList({
  emailAccountId,
  collapsed = false,
}: {
  emailAccountId: string;
  /** Icon-only sidebar rail. */
  collapsed?: boolean;
}) {
  const { data, mutate } = useIntegrations();
  const [connecting, setConnecting] = useState<string | null>(null);
  const [keyFormFor, setKeyFormFor] = useState<string | null>(null);
  const available = new Map(
    (data?.integrations ?? []).map((integration) => [
      integration.name,
      integration,
    ]),
  );
  const integrationsHref = prefixPath(emailAccountId, "/integrations");

  const keyForm = keyFormFor ? available.get(keyFormFor) : undefined;

  const connect = async (name: string) => {
    if (available.get(name)?.credentialFields?.length) {
      setKeyFormFor(name);
      return;
    }
    setConnecting(name);
    try {
      await startMcpOAuth({ integrationName: name, emailAccountId });
    } catch (error) {
      setConnecting(null);
      toastError({
        description:
          error instanceof Error && error.message
            ? error.message
            : "Couldn't start connecting. Try again.",
      });
    }
  };

  return (
    <nav aria-label="Connectors" className="flex flex-col gap-px">
      {CONNECTORS.map((connector) => {
        const integration = available.get(connector.name);
        const connected = !!integration?.connection;
        const status = connectorStatus({ integration, connected });
        const label = `${connector.displayName}: ${STATUS_LABEL[status]}`;
        const content = (
          <>
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
                <StatusMark
                  busy={connecting === connector.name}
                  status={status}
                />
              </>
            )}
          </>
        );
        const className = cn(
          "flex items-center gap-2 rounded-md py-1.5 text-left text-foreground text-sm hover:bg-muted/60",
          collapsed ? "justify-center px-0" : "px-2.5",
        );

        if (status === "available") {
          return (
            <button
              className={className}
              disabled={connecting !== null}
              key={connector.name}
              onClick={() => connect(connector.name)}
              title={collapsed ? label : undefined}
              type="button"
            >
              {content}
            </button>
          );
        }
        return (
          <Link
            className={className}
            href={integrationsHref}
            key={connector.name}
            title={collapsed ? label : undefined}
          >
            {content}
          </Link>
        );
      })}
      {keyForm?.credentialFields ? (
        <ConnectWithCredentialsDialog
          displayName={keyForm.displayName}
          emailAccountId={emailAccountId}
          fields={keyForm.credentialFields}
          integration={keyForm.name}
          onConnected={() => mutate()}
          onOpenChange={(open) => setKeyFormFor(open ? keyForm.name : null)}
          open
        />
      ) : null}
      {collapsed ? null : (
        <Link
          className="flex items-center gap-2 rounded-md px-2.5 py-1.5 text-muted-foreground text-xs hover:text-foreground"
          href={integrationsHref}
        >
          <PlusIcon className="size-3.5" />
          More connectors
        </Link>
      )}
    </nav>
  );
}

type Status = "connected" | "available" | "unavailable";

const STATUS_LABEL: Record<Status, string> = {
  connected: "connected",
  available: "not connected",
  unavailable: "not available yet",
};

function connectorStatus({
  integration,
  connected,
}: {
  integration: unknown;
  connected: boolean;
}): Status {
  if (connected) return "connected";
  // Composio apps are only listed once the server has a Composio key.
  return integration ? "available" : "unavailable";
}

function StatusMark({ status, busy }: { status: Status; busy: boolean }) {
  if (busy)
    return <span className="text-muted-foreground text-xs">Connecting…</span>;
  if (status === "connected")
    return (
      <span className="size-2 shrink-0 rounded-full bg-emerald-500">
        <span className="sr-only">Connected</span>
      </span>
    );
  if (status === "available")
    return <span className="text-primary text-xs">Connect</span>;
  return <span className="text-muted-foreground text-xs">Soon</span>;
}
