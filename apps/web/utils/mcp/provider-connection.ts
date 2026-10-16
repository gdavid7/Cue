import { findIntegration } from "@/utils/mcp/integrations";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import { ConnectionExpiredError } from "@/utils/mcp/providers/types";
import prisma from "@/utils/prisma";

/**
 * Records that the account has a provider-hosted connection to the app. The
 * provider holds the credentials; we keep only the link, its tools and, when
 * the app confirmed them, whose account they open. Connecting again clears a
 * lapse recorded for the old credentials.
 */
export async function saveProviderConnection({
  integration,
  emailAccountId,
  verified,
}: {
  integration: string;
  emailAccountId: string;
  verified?: { id: string; name: string };
}) {
  const dbIntegration = await prisma.mcpIntegration.upsert({
    where: { name: integration },
    update: {},
    create: { name: integration },
    select: { id: true },
  });

  const state = {
    isActive: true,
    needsReconnectAt: null,
    ...(verified
      ? {
          verifiedAt: new Date(),
          verifiedAs: verified.name,
          verifiedAsId: verified.id,
        }
      : {}),
  };
  await prisma.mcpConnection.upsert({
    where: {
      emailAccountId_integrationId: {
        emailAccountId,
        integrationId: dbIntegration.id,
      },
    },
    update: state,
    create: {
      name: integration,
      emailAccountId,
      integrationId: dbIntegration.id,
      ...state,
    },
  });
}

/**
 * The app turned the connection's credentials away (revoked or expired). It
 * is left out of searches and the assistant until the person reconnects, and
 * Integrations asks them to.
 */
export async function markConnectionNeedsReconnect(connectionId: string) {
  await prisma.mcpConnection.updateMany({
    where: { id: connectionId, needsReconnectAt: null },
    data: { needsReconnectAt: new Date() },
  });
}

/**
 * Runs the app's tools for one connection, outside a chat. A lapsed
 * authorization marks the connection for reconnecting, even when the caller
 * has stopped waiting for the answer.
 */
export function connectionExecutor(connection: {
  id: string;
  integrationName: string;
  emailAccountId: string;
}) {
  const provider = findIntegration(connection.integrationName)?.provider;
  if (!provider) return null;
  return (tool: string, args: Record<string, unknown>) =>
    getIntegrationProvider(provider.id)
      .executeTool({
        app: provider.app,
        authScheme: provider.authScheme,
        emailAccountId: connection.emailAccountId,
        tool,
        args,
      })
      .catch(async (error) => {
        if (error instanceof ConnectionExpiredError) {
          await markConnectionNeedsReconnect(connection.id).catch(() => null);
        }
        throw error;
      });
}
