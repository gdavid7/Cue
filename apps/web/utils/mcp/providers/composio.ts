import { createHash } from "node:crypto";
import { z } from "zod";
import { env } from "@/env";
import { createScopedLogger } from "@/utils/logger";
import {
  ConnectionExpiredError,
  CredentialsRejectedError,
  type IntegrationProvider,
} from "@/utils/mcp/providers/types";
import { redis } from "@/utils/redis";

const logger = createScopedLogger("composio");

const COMPOSIO_REQUEST_TIMEOUT_MS = 15_000;
const COMPOSIO_UPLOAD_TIMEOUT_MS = 60_000;
// Long enough to finish an app's OAuth, short enough that a forwarded link
// soon stops being completable.
const PENDING_CONNECTION_SECONDS = 15 * 60;
// The integrations list reads status on every sidebar load; a healthy
// connection is re-checked every few minutes, a lapsed one only clears when
// the user reconnects.
const ACTIVE_STATUS_CACHE_SECONDS = 10 * 60;
const LAPSED_STATUS_CACHE_SECONDS = 24 * 60 * 60;
// How apps word a lapsed authorization in a failed tool result
const AUTH_FAILURE =
  /\b401\b|unauthori[sz]ed|invalid_grant|invalid_auth|token_revoked|token[ _-]?expired|expired[ _-]?token|reauthori[sz]/i;

type ConnectionStatus = "active" | "needs_reconnect";

// Auth configs and MCP servers are shared per app across all users. Every
// instance resolves the oldest matching resource so concurrent first-time
// provisioning converges on the same one.
const authConfigIds = new Map<string, Promise<string>>();
const mcpServerUrls = new Map<string, Promise<string>>();

export const composioProvider: IntegrationProvider = {
  isConfigured: () => !!env.COMPOSIO_API_KEY,

  async getConnectUrl({
    app,
    emailAccountId,
    userId,
    callbackUrl,
    authScheme,
  }) {
    const authConfigId = await getAuthConfigId(app, authScheme);
    const link = linkSchema.parse(
      await composioFetch("/connected_accounts/link", {
        method: "POST",
        body: {
          auth_config_id: authConfigId,
          user_id: emailAccountId,
          callback_url: callbackUrl,
        },
      }),
    );

    const pending: PendingConnection = { app, emailAccountId, userId };
    await Promise.all([
      redis.set(pendingByAccountKey(link.connected_account_id), pending, {
        ex: PENDING_CONNECTION_SECONDS,
      }),
      redis.set(pendingByStarterKey(pending), link.connected_account_id, {
        ex: PENDING_CONNECTION_SECONDS,
      }),
    ]);
    return link.redirect_url;
  },

  async completeConnection({
    app,
    emailAccountId,
    userId,
    authScheme,
    connectedAccountId,
  }) {
    // One attempt per link, so a forwarded link can't be polled until
    // someone authorizes it.
    const pendingId = await redis.getdel<string>(
      pendingByStarterKey({ app, emailAccountId, userId }),
    );
    if (!pendingId) return false;
    await redis.del(pendingByAccountKey(pendingId));

    const accounts = await listConnectedAccounts({
      app,
      emailAccountId,
      authScheme,
    });
    const pendingAccount = accounts.find((account) => account.id === pendingId);
    const matchesCallback =
      !connectedAccountId || connectedAccountId === pendingId;
    if (!matchesCallback || pendingAccount?.status !== "ACTIVE") {
      if (pendingAccount) await deleteConnectedAccounts([pendingAccount]);
      return false;
    }

    await deleteConnectedAccounts(
      accounts.filter((account) => account.id !== pendingId),
    );
    await forgetStatus(app, emailAccountId);
    return true;
  },

  async discardConnection({ connectedAccountId }) {
    const pending = await redis.getdel<PendingConnection>(
      pendingByAccountKey(connectedAccountId),
    );
    // Only links we issued; an arbitrary id in a callback URL deletes nothing.
    if (!pending) return;

    await redis.del(pendingByStarterKey(pending));
    await deleteConnectedAccounts([{ id: connectedAccountId }]);
  },

  async connectWithCredentials({
    app,
    emailAccountId,
    authScheme,
    credentials,
    verifyTool,
  }) {
    const previous = await listConnectedAccounts({
      app,
      emailAccountId,
      authScheme,
    });
    const created = createdConnectedAccountSchema.parse(
      await composioFetch("/connected_accounts", {
        method: "POST",
        body: {
          auth_config: { id: await getAuthConfigId(app, authScheme) },
          connection: {
            user_id: emailAccountId,
            state: {
              authScheme: authScheme ?? "API_KEY",
              val: { status: "ACTIVE", ...credentials },
            },
          },
        },
      }),
    );

    // Composio stores API keys without checking them, so ask the app itself.
    // Whatever goes wrong, the unchecked account must not outlive the check.
    const check = await composioFetch(`/tools/execute/${verifyTool}`, {
      method: "POST",
      body: {
        connected_account_id: created.id,
        user_id: emailAccountId,
        arguments: {},
      },
    })
      .then((result) => executeResultSchema.parse(result))
      .catch(async (error) => {
        await deleteConnectedAccounts([created]).catch((deleteError) => {
          logger.error("Failed to remove an unverified connected account", {
            app,
            error: deleteError,
          });
        });
        throw error;
      });
    if (!check.successful) {
      await deleteConnectedAccounts([created]);
      throw new CredentialsRejectedError(
        `${app} rejected the credentials: ${check.error ?? "unknown error"}`,
      );
    }

    await deleteConnectedAccounts(previous);
    await forgetStatus(app, emailAccountId);
  },

  async executeTool({ app, emailAccountId, authScheme, tool, args }) {
    const account = newestActive(
      await listConnectedAccounts({ app, emailAccountId, authScheme }),
    );
    if (!account) {
      await rememberStatus(app, emailAccountId, "needs_reconnect");
      throw new ConnectionExpiredError(app, `No active ${app} connection`);
    }

    const result = executeResultSchema.parse(
      await composioFetch(`/tools/execute/${tool}`, {
        method: "POST",
        body: {
          connected_account_id: account.id,
          user_id: emailAccountId,
          arguments: args,
        },
      }),
    );
    if (!result.successful) {
      const message = `${tool} failed: ${result.error ?? "unknown error"}`;
      // Composio can keep an account ACTIVE after the app revoked its token;
      // the app's auth error is the only sign.
      if (result.error && AUTH_FAILURE.test(result.error)) {
        await rememberStatus(app, emailAccountId, "needs_reconnect");
        throw new ConnectionExpiredError(app, message);
      }
      throw new Error(message);
    }
    return result.data;
  },

  async getConnectionStatus({ app, emailAccountId, authScheme }) {
    const key = statusKey(app, emailAccountId);
    const cached = await redis.get<ConnectionStatus>(key).catch(() => null);
    if (cached) return cached;

    const status: ConnectionStatus = newestActive(
      await listConnectedAccounts({ app, emailAccountId, authScheme }),
    )
      ? "active"
      : "needs_reconnect";
    await rememberStatus(app, emailAccountId, status);
    return status;
  },

  async disconnect({ app, emailAccountId, authScheme }) {
    await deleteConnectedAccounts(
      await listConnectedAccounts({ app, emailAccountId, authScheme }),
    );
    await forgetStatus(app, emailAccountId);
  },

  async getMcpServer({ app, emailAccountId, allowedTools, authScheme }) {
    const serverUrl = await getMcpServerUrl(app, allowedTools, authScheme);
    const url = new URL(serverUrl);
    url.searchParams.set("user_id", emailAccountId);
    return {
      url: url.toString(),
      headers: { "x-api-key": getApiKey() },
    };
  },
};

/**
 * Stages a file in Composio's storage for one tool's file parameter. Composio
 * tools take files only as this staged descriptor, never as raw bytes.
 */
export async function uploadComposioFile({
  app,
  tool,
  filename,
  mimetype,
  content,
}: {
  app: string;
  tool: string;
  filename: string;
  mimetype: string;
  content: Buffer;
}): Promise<{ name: string; mimetype: string; s3key: string }> {
  const request = uploadRequestSchema.parse(
    await composioFetch("/files/upload/request", {
      method: "POST",
      body: {
        toolkit_slug: app,
        tool_slug: tool,
        filename,
        mimetype,
        md5: createHash("md5").update(content).digest("hex"),
      },
    }),
  );

  const upload = await fetch(request.new_presigned_url, {
    method: "PUT",
    headers: {
      "content-type": mimetype,
      ...(request.metadata?.storage_backend === "azure_blob_storage"
        ? { "x-ms-blob-type": "BlockBlob" }
        : {}),
    },
    body: new Uint8Array(content),
    signal: AbortSignal.timeout(COMPOSIO_UPLOAD_TIMEOUT_MS),
  });
  if (!upload.ok) {
    throw new Error(`Composio file upload failed: ${upload.status}`);
  }

  return { name: filename, mimetype, s3key: request.key };
}

function getAuthConfigId(app: string, authScheme?: "OAUTH2" | "API_KEY") {
  return memoize(authConfigIds, app, async () => {
    const name = getResourceName(app);
    const { items } = authConfigListSchema.parse(
      await composioFetch(
        `/auth_configs?${new URLSearchParams({ toolkit_slug: app, limit: "100" })}`,
      ),
    );
    const [existing] = items
      .filter((item) => item.name === name && item.status === "ENABLED")
      .sort((a, b) => a.created_at.localeCompare(b.created_at));
    if (existing) return existing.id;

    const created = createdAuthConfigSchema.parse(
      await composioFetch("/auth_configs", {
        method: "POST",
        body: {
          toolkit: { slug: app },
          // A key-based app has no Composio-managed OAuth; each user brings
          // their own credentials when they connect.
          auth_config:
            authScheme === "API_KEY"
              ? {
                  type: "use_custom_auth",
                  authScheme: "API_KEY",
                  name,
                  credentials: {},
                }
              : { type: "use_composio_managed_auth", name },
        },
      }),
    );
    logger.info("Created Composio auth config", { app });
    return created.auth_config.id;
  });
}

function getMcpServerUrl(
  app: string,
  allowedTools: string[],
  authScheme?: "OAUTH2" | "API_KEY",
) {
  return memoize(mcpServerUrls, app, async () => {
    const authConfigId = await getAuthConfigId(app, authScheme);
    const name = getResourceName(app);
    const { items } = mcpServerListSchema.parse(
      await composioFetch(
        `/mcp/servers?${new URLSearchParams({
          name,
          order_by: "created_at",
          order_direction: "asc",
        })}`,
      ),
    );
    const existing = items.find(
      (item) =>
        item.name === name && item.auth_config_ids.includes(authConfigId),
    );

    if (!existing) {
      const created = mcpServerSchema.parse(
        await composioFetch("/mcp/servers", {
          method: "POST",
          body: {
            name,
            auth_config_ids: [authConfigId],
            allowed_tools: allowedTools,
          },
        }),
      );
      logger.info("Created Composio MCP server", { app });
      return created.mcp_url;
    }

    // The server enforces the allowlist, so keep it in step with the registry
    if (!haveSameItems(existing.allowed_tools, allowedTools)) {
      await composioFetch(`/mcp/${existing.id}`, {
        method: "PATCH",
        body: { allowed_tools: allowedTools },
      });
      logger.info("Updated Composio MCP server tools", { app });
    }
    return existing.mcp_url;
  });
}

async function listConnectedAccounts({
  app,
  emailAccountId,
  authScheme,
}: {
  app: string;
  emailAccountId: string;
  authScheme?: "OAUTH2" | "API_KEY";
}) {
  const authConfigId = await getAuthConfigId(app, authScheme);
  const { items } = connectedAccountListSchema.parse(
    await composioFetch(
      `/connected_accounts?${new URLSearchParams({
        user_ids: emailAccountId,
        auth_config_ids: authConfigId,
        limit: "100",
      })}`,
    ),
  );
  return items;
}

function newestActive<T extends { status: string; created_at: string }>(
  accounts: T[],
): T | undefined {
  return accounts
    .filter((account) => account.status === "ACTIVE")
    .sort((a, b) => b.created_at.localeCompare(a.created_at))[0];
}

type PendingConnection = {
  app: string;
  emailAccountId: string;
  userId: string;
};

function pendingByAccountKey(connectedAccountId: string) {
  return `composio-pending-connection:${connectedAccountId}`;
}

function pendingByStarterKey({
  app,
  emailAccountId,
  userId,
}: PendingConnection) {
  return `composio-pending-connection:${app}:${emailAccountId}:${userId}`;
}

function statusKey(app: string, emailAccountId: string) {
  return `composio-status:${app}:${emailAccountId}`;
}

async function rememberStatus(
  app: string,
  emailAccountId: string,
  status: ConnectionStatus,
) {
  await redis
    .set(statusKey(app, emailAccountId), status, {
      ex:
        status === "active"
          ? ACTIVE_STATUS_CACHE_SECONDS
          : LAPSED_STATUS_CACHE_SECONDS,
    })
    .catch((error) => {
      logger.warn("Failed to cache connection status", { app, error });
    });
}

async function forgetStatus(app: string, emailAccountId: string) {
  await redis.del(statusKey(app, emailAccountId)).catch((error) => {
    logger.warn("Failed to clear connection status", { app, error });
  });
}

async function deleteConnectedAccounts(accounts: { id: string }[]) {
  await Promise.all(
    accounts.map((account) =>
      composioFetch(`/connected_accounts/${account.id}`, { method: "DELETE" }),
    ),
  );
}

async function composioFetch(
  path: string,
  options: {
    method?: "GET" | "POST" | "PATCH" | "DELETE";
    body?: unknown;
  } = {},
): Promise<unknown> {
  const response = await fetch(`${env.COMPOSIO_API_URL}${path}`, {
    method: options.method ?? "GET",
    headers: {
      "x-api-key": getApiKey(),
      ...(options.body ? { "content-type": "application/json" } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
  });

  if (!response.ok) {
    // Composio explains rejections (e.g. missing key permissions) in the body
    const reason = await response.text().catch(() => "");
    throw new Error(
      `Composio request failed: ${options.method ?? "GET"} ${path.split("?")[0]} returned ${response.status}${reason ? `: ${reason.slice(0, 500)}` : ""}`,
    );
  }

  return response.json();
}

function getApiKey() {
  if (!env.COMPOSIO_API_KEY) throw new Error("COMPOSIO_API_KEY is not set");
  return env.COMPOSIO_API_KEY;
}

function getResourceName(app: string) {
  return `inbox-zero-${app}`;
}

function memoize(
  cache: Map<string, Promise<string>>,
  key: string,
  load: () => Promise<string>,
) {
  const cached = cache.get(key);
  if (cached) return cached;

  const pending = load().catch((error) => {
    cache.delete(key);
    throw error;
  });
  cache.set(key, pending);
  return pending;
}

function haveSameItems(a: string[], b: string[]) {
  return a.length === b.length && a.every((item) => b.includes(item));
}

const linkSchema = z.object({
  redirect_url: z.string().url(),
  connected_account_id: z.string().min(1),
});

const uploadRequestSchema = z.object({
  key: z.string(),
  new_presigned_url: z.string().url(),
  metadata: z.object({ storage_backend: z.string() }).nullish(),
});

const authConfigListSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      status: z.string(),
      created_at: z.string(),
    }),
  ),
});

const createdAuthConfigSchema = z.object({
  auth_config: z.object({ id: z.string() }),
});

const mcpServerSchema = z.object({
  id: z.string(),
  name: z.string(),
  mcp_url: z.string().url(),
  auth_config_ids: z.array(z.string()),
  allowed_tools: z.array(z.string()),
});

const mcpServerListSchema = z.object({ items: z.array(mcpServerSchema) });

const createdConnectedAccountSchema = z.object({ id: z.string() });

const executeResultSchema = z.object({
  data: z.unknown(),
  successful: z.boolean(),
  error: z.string().nullish(),
});

const connectedAccountListSchema = z.object({
  items: z.array(
    z.object({ id: z.string(), status: z.string(), created_at: z.string() }),
  ),
});
