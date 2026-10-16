import { findIntegration } from "@/utils/mcp/integrations";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import {
  AppToolError,
  ConnectionExpiredError,
} from "@/utils/mcp/providers/types";
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
export async function markConnectionNeedsReconnect(
  connectionId: string,
  /** When the failed call began; a reconnect since then wins. */
  startedAt: Date,
) {
  await prisma.mcpConnection.updateMany({
    where: {
      id: connectionId,
      needsReconnectAt: null,
      updatedAt: { lt: startedAt },
    },
    data: { needsReconnectAt: new Date() },
  });
}

/**
 * Runs the app's tools for one connection, outside a chat. A lapsed
 * authorization marks the connection for reconnecting, even when the caller
 * has stopped waiting for the answer.
 *
 * An app's auth-looking error can also mean one resource is off limits to a
 * working token (Canvas answers both with a 401), so unless the provider
 * itself has lost the authorization, the app's check tool is asked first.
 * An error that check doesn't confirm comes back as an AppToolError.
 */
export function connectionExecutor(connection: {
  id: string;
  integrationName: string;
  emailAccountId: string;
}) {
  const config = findIntegration(connection.integrationName);
  const provider = config?.provider;
  if (!provider) return null;
  const appArgs = {
    app: provider.app,
    authScheme: provider.authScheme,
    emailAccountId: connection.emailAccountId,
  };

  const isLapsed = async (error: ConnectionExpiredError, tool: string) => {
    if (error.confirmed) return true;
    const verifyTool = config.verifyTool;
    if (!verifyTool) return false;
    if (tool === verifyTool) return true;
    try {
      await getIntegrationProvider(provider.id).checkConnection({
        ...appArgs,
        tool: verifyTool,
      });
      return false;
    } catch (checkError) {
      return checkError instanceof ConnectionExpiredError;
    }
  };

  return async (tool: string, args: Record<string, unknown>) => {
    const startedAt = new Date();
    try {
      return await getIntegrationProvider(provider.id).executeTool({
        ...appArgs,
        tool,
        args,
      });
    } catch (error) {
      if (!(error instanceof ConnectionExpiredError)) throw error;
      if (!(await isLapsed(error, tool))) {
        throw new AppToolError(provider.app, tool, error.message);
      }
      await markConnectionNeedsReconnect(connection.id, startedAt).catch(
        () => null,
      );
      throw error;
    }
  };
}
