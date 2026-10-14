import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import type { Logger } from "@/utils/logger";
import { findIntegration, MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import { fromDbAuthType } from "@/utils/mcp/resolve-integration";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import {
  onePerIntegration,
  ownedBySameUser,
} from "@/utils/mcp/user-connections";
import prisma from "@/utils/prisma";

const STATUS_TIMEOUT_MS = 3000;

export type GetIntegrationsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("mcp/integrations", async (request) => {
  const emailAccountId = request.auth.emailAccountId;
  return NextResponse.json(await getData(emailAccountId, request.logger));
});

// Apps connected from any of the person's email accounts show as connected in
// every one of them.
async function getData(emailAccountId: string, logger: Logger) {
  const [allConnections, customIntegrations] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: ownedBySameUser(emailAccountId),
      select: {
        id: true,
        name: true,
        isActive: true,
        emailAccountId: true,
        emailAccount: { select: { email: true } },
        integration: { select: { id: true, name: true } },
        tools: {
          where: { isWrite: false },
          select: { id: true, name: true, description: true, isEnabled: true },
        },
      },
      orderBy: { createdAt: "asc" },
    }),
    prisma.mcpIntegration.findMany({
      where: ownedBySameUser(emailAccountId),
      select: {
        name: true,
        displayName: true,
        serverUrl: true,
        authType: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

  const connections = await Promise.all(
    onePerIntegration(allConnections, emailAccountId).map(
      async ({
        emailAccountId: connectionAccountId,
        emailAccount,
        ...connection
      }) => ({
        ...connection,
        // Their other account it was connected from, if not this one
        connectedVia:
          connectionAccountId === emailAccountId
            ? null
            : (emailAccount?.email ?? null),
        needsReconnect: await needsReconnect(
          connection.integration.name,
          connectionAccountId,
          logger,
        ),
      }),
    ),
  );
  const findConnection = (name: string) =>
    connections.find((connection) => connection.integration.name === name);

  // Cue offers the apps Composio hosts. Others stay listed only once
  // connected, so an existing connection can still be managed or removed.
  const builtIn = Object.values(MCP_INTEGRATIONS)
    .filter((integration) =>
      integration.provider
        ? getIntegrationProvider(integration.provider.id).isConfigured()
        : !!findConnection(integration.name),
    )
    .map((integration) => ({
      name: integration.name,
      displayName: integration.displayName,
      shortName: integration.shortName,
      description: integration.description,
      url: integration.url,
      logo: integration.logo,
      comingSoon: integration.comingSoon,
      authType: integration.authType,
      credentialFields: integration.credentialFields,
      isCustom: false,
      connection: findConnection(integration.name),
    }));

  const custom = customIntegrations.map((integration) => {
    const host = getHostname(integration.serverUrl);

    return {
      name: integration.name,
      displayName: integration.displayName || integration.name,
      shortName: undefined,
      description: host,
      url: host,
      logo: undefined,
      comingSoon: undefined,
      authType: integration.authType
        ? fromDbAuthType(integration.authType)
        : ("oauth" as const),
      credentialFields: undefined,
      isCustom: true,
      connection: findConnection(integration.name),
    };
  });

  return { integrations: [...builtIn, ...custom] };
}

// A provider can lose an app's authorization (expired or revoked) while Cue
// still holds the connection. Unknown counts as healthy, so a slow provider
// never blocks the list.
async function needsReconnect(
  integrationName: string,
  connectionAccountId: string | null,
  logger: Logger,
) {
  const provider = findIntegration(integrationName)?.provider;
  if (!provider || !connectionAccountId) return false;
  const status = await Promise.race([
    getIntegrationProvider(provider.id).getConnectionStatus({
      app: provider.app,
      authScheme: provider.authScheme,
      emailAccountId: connectionAccountId,
    }),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), STATUS_TIMEOUT_MS),
    ),
  ]).catch((error) => {
    logger.warn("Failed to read connection status", {
      integration: integrationName,
      error,
    });
    return null;
  });
  return status === "needs_reconnect";
}

function getHostname(serverUrl: string | null) {
  if (!serverUrl) return "";
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return serverUrl;
  }
}
