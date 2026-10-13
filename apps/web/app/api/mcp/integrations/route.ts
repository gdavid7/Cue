import { NextResponse } from "next/server";
import { withEmailAccount } from "@/utils/middleware";
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import { fromDbAuthType } from "@/utils/mcp/resolve-integration";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import prisma from "@/utils/prisma";

export type GetIntegrationsResponse = Awaited<ReturnType<typeof getData>>;

export const GET = withEmailAccount("mcp/integrations", async (request) => {
  const emailAccountId = request.auth.emailAccountId;
  return NextResponse.json(await getData(emailAccountId));
});

async function getData(emailAccountId: string) {
  const [connections, customIntegrations] = await Promise.all([
    prisma.mcpConnection.findMany({
      where: { emailAccountId },
      select: {
        id: true,
        name: true,
        isActive: true,
        integration: { select: { id: true, name: true } },
        tools: {
          where: { isWrite: false },
          select: { id: true, name: true, description: true, isEnabled: true },
        },
      },
    }),
    prisma.mcpIntegration.findMany({
      where: { emailAccountId },
      select: {
        name: true,
        displayName: true,
        serverUrl: true,
        authType: true,
      },
      orderBy: { createdAt: "asc" },
    }),
  ]);

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

function getHostname(serverUrl: string | null) {
  if (!serverUrl) return "";
  try {
    return new URL(serverUrl).hostname;
  } catch {
    return serverUrl;
  }
}
