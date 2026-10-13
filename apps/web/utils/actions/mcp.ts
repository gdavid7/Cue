"use server";

import { randomUUID } from "node:crypto";
import { actionClient } from "@/utils/actions/safe-action";
import {
  connectWithCredentialsBody,
  createCustomMcpServerBody,
  disconnectMcpConnectionBody,
  removeCustomMcpServerBody,
  toggleMcpConnectionBody,
  toggleMcpToolBody,
} from "@/utils/actions/mcp.validation";
import { SafeError } from "@/utils/error";
import {
  CUSTOM_INTEGRATION_PREFIX,
  toDbAuthType,
} from "@/utils/mcp/resolve-integration";
import { assertIntegrationsTierAccess } from "@/utils/mcp/tier-access";
import { findIntegration } from "@/utils/mcp/integrations";
import { saveProviderConnection } from "@/utils/mcp/provider-connection";
import { getIntegrationProvider } from "@/utils/mcp/providers/registry";
import { CredentialsRejectedError } from "@/utils/mcp/providers/types";
import { syncMcpTools } from "@/utils/mcp/sync-tools";
import { getCustomMcpServerUrlError } from "@/utils/mcp/safe-fetch";
import {
  findConnectionAccountId,
  ownedBySameUser,
} from "@/utils/mcp/user-connections";
import prisma from "@/utils/prisma";

const MAX_CUSTOM_SERVERS_PER_USER = 10;

/**
 * Connects an app that takes a key instead of OAuth (Canvas: the school's
 * address and a personal access token). The app checks the key before
 * anything is saved.
 */
export const connectWithCredentialsAction = actionClient
  .metadata({ name: "connectWithCredentials" })
  .inputSchema(connectWithCredentialsBody)
  .action(
    async ({
      ctx: { emailAccountId, userId, logger },
      parsedInput: { integration, credentials },
    }) => {
      await assertIntegrationsTierAccess({ userId, logger });

      const config = findIntegration(integration);
      if (
        !config?.provider ||
        !config.credentialFields?.length ||
        !config.verifyTool
      ) {
        throw new SafeError(`${integration} doesn't connect with a key`);
      }
      const provider = getIntegrationProvider(config.provider.id);
      if (!provider.isConfigured()) {
        throw new SafeError(`${config.displayName} is not available`);
      }

      const values: Record<string, string> = {};
      for (const field of config.credentialFields) {
        const value = credentials[field.name]?.trim();
        if (!value) throw new SafeError(`${field.label} is required`);
        values[field.name] =
          field.kind === "url" ? normalizeAppUrl(value, field.label) : value;
      }

      // Connecting again from another of their accounts replaces the
      // existing connection instead of adding a second one.
      const connectionAccountId =
        (await findConnectionAccountId({ integration, emailAccountId })) ??
        emailAccountId;

      try {
        await provider.connectWithCredentials({
          app: config.provider.app,
          authScheme: config.provider.authScheme,
          emailAccountId: connectionAccountId,
          credentials: values,
          verifyTool: config.verifyTool,
        });
      } catch (error) {
        if (error instanceof CredentialsRejectedError) {
          logger.warn("Credentials rejected", { integration });
          throw new SafeError(
            `${config.displayName} didn't accept that. Check the address and token, then try again.`,
          );
        }
        throw error;
      }

      await saveProviderConnection({
        integration,
        emailAccountId: connectionAccountId,
      });
      await syncMcpTools(integration, connectionAccountId, logger);
    },
  );

/**
 * Disconnects the app from all of the person's email accounts, including a
 * second connection to it made from another account.
 */
export const disconnectMcpConnectionAction = actionClient
  .metadata({ name: "disconnectMcpConnection" })
  .inputSchema(disconnectMcpConnectionBody)
  .action(
    async ({ ctx: { emailAccountId }, parsedInput: { connectionId } }) => {
      const connection = await prisma.mcpConnection.findFirst({
        where: { id: connectionId, ...ownedBySameUser(emailAccountId) },
        select: {
          integrationId: true,
          integration: { select: { name: true } },
        },
      });
      if (!connection) throw new SafeError("Connection not found");

      const connections = await prisma.mcpConnection.findMany({
        where: {
          integrationId: connection.integrationId,
          ...ownedBySameUser(emailAccountId),
        },
        select: { id: true, emailAccountId: true },
      });

      // Revoke at the provider first so it never keeps tokens we no longer track
      const provider = findIntegration(connection.integration.name)?.provider;
      if (provider) {
        const accountIds = connections.flatMap((c) =>
          c.emailAccountId ? [c.emailAccountId] : [],
        );
        await Promise.all(
          accountIds.map((connectionAccountId) =>
            getIntegrationProvider(provider.id).disconnect({
              app: provider.app,
              authScheme: provider.authScheme,
              emailAccountId: connectionAccountId,
            }),
          ),
        );
      }

      await prisma.mcpConnection.deleteMany({
        where: {
          id: { in: connections.map(({ id }) => id) },
          ...ownedBySameUser(emailAccountId),
        },
      });
    },
  );

export const toggleMcpConnectionAction = actionClient
  .metadata({ name: "toggleMcpConnection" })
  .inputSchema(toggleMcpConnectionBody)
  .action(
    async ({
      ctx: { emailAccountId },
      parsedInput: { connectionId, isActive },
    }) => {
      await prisma.mcpConnection.update({
        where: { id: connectionId, ...ownedBySameUser(emailAccountId) },
        data: { isActive },
      });
    },
  );

export const toggleMcpToolAction = actionClient
  .metadata({ name: "toggleMcpTool" })
  .inputSchema(toggleMcpToolBody)
  .action(
    async ({ ctx: { emailAccountId }, parsedInput: { toolId, isEnabled } }) => {
      await prisma.mcpTool.update({
        where: { id: toolId, connection: ownedBySameUser(emailAccountId) },
        data: { isEnabled },
      });
    },
  );

export const createCustomMcpServerAction = actionClient
  .metadata({ name: "createCustomMcpServer" })
  .inputSchema(createCustomMcpServerBody)
  .action(
    async ({
      ctx: { emailAccountId, userId, logger },
      parsedInput: { displayName, serverUrl, authType, apiKey },
    }) => {
      await assertIntegrationsTierAccess({ userId, logger });

      const urlError = getCustomMcpServerUrlError(serverUrl);
      if (urlError) throw new SafeError(urlError);

      const existingCount = await prisma.mcpIntegration.count({
        where: ownedBySameUser(emailAccountId),
      });

      if (existingCount >= MAX_CUSTOM_SERVERS_PER_USER) {
        throw new SafeError(
          `You can add up to ${MAX_CUSTOM_SERVERS_PER_USER} custom servers.`,
        );
      }

      const name = `${CUSTOM_INTEGRATION_PREFIX}${randomUUID().replace(/-/g, "")}`;

      const integration = await prisma.mcpIntegration.create({
        data: {
          name,
          displayName,
          serverUrl,
          authType: toDbAuthType(authType),
          emailAccountId,
        },
        select: { id: true },
      });

      if (authType === "oauth") return { name };

      try {
        await prisma.mcpConnection.create({
          data: {
            name: displayName,
            emailAccountId,
            integrationId: integration.id,
            apiKey: authType === "api-token" ? apiKey : null,
            isActive: true,
          },
        });

        await syncMcpTools(name, emailAccountId, logger);
      } catch (error) {
        logger.error("Failed to connect custom MCP server", { error });
        await prisma.mcpIntegration.delete({ where: { id: integration.id } });
        throw new SafeError(
          authType === "api-token"
            ? "Could not connect to the server. Check the URL and API key."
            : "Could not connect to the server. Check the URL, or choose an authentication method if the server requires one.",
        );
      }

      return { name };
    },
  );

export const removeCustomMcpServerAction = actionClient
  .metadata({ name: "removeCustomMcpServer" })
  .inputSchema(removeCustomMcpServerBody)
  .action(async ({ ctx: { emailAccountId }, parsedInput: { name } }) => {
    const { count } = await prisma.mcpIntegration.deleteMany({
      where: { name, ...ownedBySameUser(emailAccountId) },
    });

    if (!count) throw new SafeError("Server not found");
  });

/** "canvas.ucsd.edu/" becomes "https://canvas.ucsd.edu": the form the app expects. */
function normalizeAppUrl(value: string, label: string) {
  const withScheme = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new SafeError(`${label} isn't a valid address`);
  }
  if (url.protocol !== "https:") {
    throw new SafeError(`${label} must start with https://`);
  }
  return url.origin;
}
