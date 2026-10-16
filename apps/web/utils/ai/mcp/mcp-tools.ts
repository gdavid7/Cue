import { createMCPClient } from "@ai-sdk/mcp";
import {
  CUSTOM_INTEGRATION_PREFIX,
  resolveMcpIntegration,
  type ResolvedMcpIntegration,
} from "@/utils/mcp/resolve-integration";
import { syncMcpTools } from "@/utils/mcp/sync-tools";
import prisma from "@/utils/prisma";
import { createScopedLogger, type Logger } from "@/utils/logger";
import { createMcpTransport } from "@/utils/mcp/transport";
import { getMcpServerConnection } from "@/utils/mcp/server-connection";
import { isValidMcpToolName } from "@/utils/mcp/tool-name";
import {
  onePerIntegration,
  ownedBySameUser,
} from "@/utils/mcp/user-connections";

type MCPClient = Awaited<ReturnType<typeof createMCPClient>>;

// Connected apps add context; they shouldn't hold up a draft or a brief.
const MCP_CONNECT_TIMEOUT_MS = 8000;
const MCP_TOOL_CALL_TIMEOUT_MS = 15_000;
// A list call (e.g. every record in a table) can be far bigger than the model
// needs or its context fits.
const MAX_TOOL_RESULT_CHARS = 20_000;

// Connections with a tool re-sync under way in this process
const resyncing = new Set<string>();

export type MCPToolsResult = {
  tools: Record<string, unknown>;
  cleanup: () => Promise<void>;
};

export async function createMcpToolsForAgent(
  emailAccountId: string,
): Promise<MCPToolsResult> {
  const logger = createScopedLogger("ai-mcp-tools").with({ emailAccountId });

  try {
    // Apps connected from any of the person's email accounts
    const allConnections = await prisma.mcpConnection.findMany({
      where: {
        ...ownedBySameUser(emailAccountId),
        isActive: true,
        // The app turned its credentials away; every call would fail the
        // same way until the person reconnects.
        needsReconnectAt: null,
        tools: {
          some: {
            isEnabled: true,
            isWrite: false,
          },
        },
      },
      select: {
        id: true,
        emailAccountId: true,
        integration: {
          select: {
            id: true,
            name: true,
          },
        },
        // Every stored tool, so an out-of-date tool list can be noticed
        tools: {
          select: { name: true, isEnabled: true, isWrite: true },
        },
      },
      orderBy: { createdAt: "asc" },
    });
    const connections = onePerIntegration(allConnections, emailAccountId);

    if (connections.length === 0) {
      return {
        tools: {},
        cleanup: async () => {},
      };
    }

    const clients: MCPClient[] = [];
    let closed = false;
    const closeClient = async (client: MCPClient) => {
      try {
        await client.close();
      } catch (error) {
        logger.warn("Error closing MCP client", { error });
      }
    };

    const toolsByIntegration: Map<
      string,
      { toolPrefix: string; tools: Record<string, unknown> }
    > = new Map();

    // Apps are independent, so they connect side by side, and one that is
    // slow to answer is left out rather than holding up the rest.
    await Promise.all(
      connections.map(async (connection) => {
        const integration = connection.integration;
        // The app's provider and stored credentials know the connection by
        // the account it was made from
        const connectionAccountId = connection.emailAccountId;
        if (!connectionAccountId) return;

        try {
          await withTimeout(
            (async () => {
              const integrationConfig = await resolveMcpIntegration({
                name: integration.name,
                emailAccountId: connectionAccountId,
              });
              if (!integrationConfig) {
                logger.warn("Integration config not found", {
                  integration: integration.name,
                });
                return;
              }

              const transport = createMcpTransport(
                await getMcpServerConnection(
                  integrationConfig,
                  connectionAccountId,
                ),
              );
              const mcpClient = await createMCPClient({ transport });
              // Cleanup may have run while this one was still connecting
              if (closed) {
                await closeClient(mcpClient);
                return;
              }
              clients.push(mcpClient);

              const mcpTools = await mcpClient.tools();

              // Filter to only enabled tools
              const enabledToolNames = connection.tools
                .filter((tool) => tool.isEnabled && !tool.isWrite)
                .map((tool) => tool.name);

              if (
                isToolListOutdated(
                  integrationConfig,
                  Object.keys(mcpTools),
                  connection.tools.map((tool) => tool.name),
                )
              ) {
                resyncTools(
                  connection.id,
                  integration.name,
                  connectionAccountId,
                  logger,
                );
              }

              const filteredTools = Object.fromEntries(
                Object.entries(mcpTools)
                  .filter(([toolName]) => enabledToolNames.includes(toolName))
                  .map(([toolName, toolDef]) => [
                    toolName,
                    withCallLimits(toolDef),
                  ]),
              );

              toolsByIntegration.set(integration.id, {
                // Custom names carry a 32-char id; a short slice keeps
                // prefixed tool names within provider length limits
                toolPrefix: integrationConfig.isCustom
                  ? integration.name.slice(
                      0,
                      CUSTOM_INTEGRATION_PREFIX.length + 8,
                    )
                  : integration.name,
                tools: filteredTools,
              });
            })(),
            MCP_CONNECT_TIMEOUT_MS,
          );
        } catch (error) {
          logger.error("Failed to create MCP client for integration", {
            error,
            integration: integration.name,
          });
          // Continue with other integrations
        }
      }),
    );

    // Order by connection, not by which app answered first
    const orderedTools = new Map(
      connections.flatMap((connection) => {
        const entry = toolsByIntegration.get(connection.integration.id);
        return entry ? [[connection.integration.id, entry] as const] : [];
      }),
    );
    const allTools = mergeToolsWithConflictResolution(orderedTools, logger);

    return {
      tools: allTools,
      cleanup: async () => {
        closed = true;
        await Promise.all(clients.map(closeClient));
      },
    };
  } catch (error) {
    logger.error("Failed to create MCP tools for agent", { error });
    return {
      tools: {},
      cleanup: async () => {},
    };
  }
}

/**
 * Merges tools from multiple integrations, adding integration prefix only when there are naming conflicts.
 *
 * @param toolsByIntegration - Map of integration tools grouped by integration
 * @returns Merged tools with prefixes added only for conflicting names
 */
function mergeToolsWithConflictResolution(
  toolsByIntegration: Map<
    string,
    { toolPrefix: string; tools: Record<string, unknown> }
  >,
  logger: Logger,
): Record<string, unknown> {
  const allTools: Record<string, unknown> = {};
  const toolNameToIntegrations = new Map<string, string[]>();

  // Build a map of tool names to their integrations
  for (const [_, { toolPrefix, tools }] of toolsByIntegration) {
    for (const toolName of Object.keys(tools)) {
      if (!toolNameToIntegrations.has(toolName)) {
        toolNameToIntegrations.set(toolName, []);
      }
      toolNameToIntegrations.get(toolName)!.push(toolPrefix);
    }
  }

  // Merge tools, prefixing only when there's a conflict
  for (const [__, { toolPrefix, tools }] of toolsByIntegration) {
    for (const [toolName, toolDef] of Object.entries(tools)) {
      const integrationsWithThisTool = toolNameToIntegrations.get(toolName)!;

      // Only prefix if this tool name appears in multiple integrations
      const finalToolName =
        integrationsWithThisTool.length > 1
          ? `${toolPrefix}-${toolName}`
          : toolName;

      // One invalid name would fail the whole model call, not just this tool
      if (!isValidMcpToolName(finalToolName)) {
        logger.warn("Skipping MCP tool with an unsupported name", {
          toolPrefix,
          nameLength: finalToolName.length,
        });
        continue;
      }

      allTools[finalToolName] = toolDef;
    }
  }

  return allTools;
}

type ToolExecute = (
  args: unknown,
  options: { abortSignal?: AbortSignal } & Record<string, unknown>,
) => Promise<unknown>;

/** Bounds each call's time and the size of what it hands the model. */
function withCallLimits(toolDef: unknown): unknown {
  const execute = (toolDef as { execute?: ToolExecute }).execute;
  if (typeof execute !== "function") return toolDef;
  return {
    ...(toolDef as object),
    execute: async (
      args: unknown,
      options: Parameters<ToolExecute>[1] = {},
    ) => {
      const timeout = AbortSignal.timeout(MCP_TOOL_CALL_TIMEOUT_MS);
      const abortSignal = options.abortSignal
        ? AbortSignal.any([options.abortSignal, timeout])
        : timeout;
      return capToolResult(await execute(args, { ...options, abortSignal }));
    },
  };
}

/**
 * Cuts an MCP result to MAX_TOOL_RESULT_CHARS, keeping the MCP content shape
 * the model output is built from, with a note that it was cut.
 */
function capToolResult(result: unknown): unknown {
  const content = (result as { content?: unknown })?.content;
  if (Array.isArray(content)) {
    const total = content.reduce<number>(
      (sum, part) => sum + partText(part).length,
      0,
    );
    if (total <= MAX_TOOL_RESULT_CHARS) return result;

    let remaining = MAX_TOOL_RESULT_CHARS;
    const kept: unknown[] = [];
    for (const part of content) {
      if (remaining <= 0) break;
      const text = partText(part);
      if (text.length <= remaining) {
        kept.push(part);
      } else {
        kept.push({ type: "text", text: text.slice(0, remaining) });
      }
      remaining -= text.length;
    }
    return {
      ...(result as object),
      content: [...kept, truncationNote(total)],
      structuredContent: undefined,
    };
  }

  const json = JSON.stringify(result) ?? "";
  if (json.length <= MAX_TOOL_RESULT_CHARS) return result;
  return {
    content: [
      { type: "text", text: json.slice(0, MAX_TOOL_RESULT_CHARS) },
      truncationNote(json.length),
    ],
  };
}

function partText(part: unknown): string {
  const { type, text } = (part ?? {}) as { type?: string; text?: unknown };
  return type === "text" && typeof text === "string"
    ? text
    : (JSON.stringify(part) ?? "");
}

function truncationNote(total: number) {
  return {
    type: "text",
    text: `[Result truncated: showing the first ${MAX_TOOL_RESULT_CHARS} of ${total} characters.]`,
  };
}

/**
 * Tools are stored at connect time, so a later change to a curated allowlist
 * would never reach existing connections. The server's live list shows when
 * an allowed tool is missing from the stored ones, or a stored one is no
 * longer allowed.
 */
function isToolListOutdated(
  integration: ResolvedMcpIntegration,
  liveToolNames: string[],
  storedToolNames: string[],
) {
  if (integration.isCustom || !integration.allowedTools) return false;

  const curated = new Set([
    ...integration.allowedTools,
    ...(integration.ruleActionWriteTools ?? []),
  ]);
  const stored = new Set(storedToolNames);
  return (
    liveToolNames.some((name) => curated.has(name) && !stored.has(name)) ||
    storedToolNames.some((name) => !curated.has(name))
  );
}

/**
 * Refreshes the stored tools in the background, keeping the user's on/off
 * choices; this run goes ahead with what is stored.
 */
function resyncTools(
  connectionId: string,
  integrationName: string,
  emailAccountId: string,
  logger: Logger,
) {
  if (resyncing.has(connectionId)) return;
  resyncing.add(connectionId);

  syncMcpTools(integrationName, emailAccountId, logger)
    // syncMcpTools logs its own failure; the next run tries again
    .catch(() => {})
    .finally(() => resyncing.delete(connectionId));
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Timed out after ${ms}ms`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}
