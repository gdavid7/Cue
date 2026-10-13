import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { composioProvider } from "@/utils/mcp/providers/composio";
import { CredentialsRejectedError } from "@/utils/mcp/providers/types";

vi.mock("@/env", () => ({
  env: {
    COMPOSIO_API_KEY: "test-composio-key",
    COMPOSIO_API_URL: "https://backend.composio.dev/api/v3",
  },
}));

// The provider memoizes per app for the life of the process, so each test uses
// its own app name.
describe("composioProvider", () => {
  let api: ReturnType<typeof createFakeComposioApi>;

  beforeEach(() => {
    api = createFakeComposioApi();
    vi.stubGlobal("fetch", api.fetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("scopes the MCP server to the email account and authenticates with the API key", async () => {
    const server = await composioProvider.getMcpServer({
      app: "app-scope",
      emailAccountId: "email-account-1",
      allowedTools: ["APP_SEARCH"],
    });

    const url = new URL(server.url);
    expect(url.searchParams.get("user_id")).toBe("email-account-1");
    expect(server.headers).toEqual({ "x-api-key": "test-composio-key" });
    expect(api.state.servers).toHaveLength(1);
    expect(api.state.servers[0].allowed_tools).toEqual(["APP_SEARCH"]);
  });

  it("reuses the existing shared server and syncs its tool allowlist", async () => {
    api.state.authConfigs.push({
      id: "ac_existing",
      name: "inbox-zero-app-reuse",
      status: "ENABLED",
      created_at: "2026-01-01T00:00:00Z",
    });
    api.state.servers.push({
      id: "server-existing",
      name: "inbox-zero-app-reuse",
      mcp_url: "https://mcp.example.com/server-existing",
      auth_config_ids: ["ac_existing"],
      allowed_tools: ["APP_OLD_TOOL"],
    });

    const server = await composioProvider.getMcpServer({
      app: "app-reuse",
      emailAccountId: "email-account-1",
      allowedTools: ["APP_SEARCH", "APP_GET"],
    });

    expect(server.url).toContain("server-existing");
    expect(api.state.authConfigs).toHaveLength(1);
    expect(api.state.servers).toHaveLength(1);
    expect(api.state.servers[0].allowed_tools).toEqual([
      "APP_SEARCH",
      "APP_GET",
    ]);
  });

  it("keeps only the newest active account when a connection completes", async () => {
    const authConfigId = await createAuthConfig("app-complete");
    api.state.accounts.push(
      account("ca_old", "email-account-1", authConfigId, "ACTIVE", "2026-01"),
      account("ca_new", "email-account-1", authConfigId, "ACTIVE", "2026-03"),
      account("ca_stale", "email-account-1", authConfigId, "FAILED", "2026-02"),
      account("ca_other", "email-account-2", authConfigId, "ACTIVE", "2026-01"),
    );

    const connected = await composioProvider.completeConnection({
      app: "app-complete",
      emailAccountId: "email-account-1",
    });

    expect(connected).toBe(true);
    expect(api.state.accounts.map((a) => a.id).sort()).toEqual([
      "ca_new",
      "ca_other",
    ]);
  });

  it("reports an incomplete connection when no account is active", async () => {
    const authConfigId = await createAuthConfig("app-incomplete");
    api.state.accounts.push(
      account("ca_1", "email-account-1", authConfigId, "INITIALIZING", "2026"),
    );

    const connected = await composioProvider.completeConnection({
      app: "app-incomplete",
      emailAccountId: "email-account-1",
    });

    expect(connected).toBe(false);
    expect(api.state.accounts).toHaveLength(1);
  });

  it("revokes every account for the email account on disconnect", async () => {
    const authConfigId = await createAuthConfig("app-disconnect");
    api.state.accounts.push(
      account("ca_1", "email-account-1", authConfigId, "ACTIVE", "2026-01"),
      account("ca_2", "email-account-1", authConfigId, "FAILED", "2026-02"),
      account("ca_3", "email-account-2", authConfigId, "ACTIVE", "2026-01"),
    );

    await composioProvider.disconnect({
      app: "app-disconnect",
      emailAccountId: "email-account-1",
    });

    expect(api.state.accounts.map((a) => a.id)).toEqual(["ca_3"]);
  });

  it("connects a key-based app only after the app accepts the key", async () => {
    api.state.validKeys.add("good-token");
    api.state.authConfigs.push({
      id: "ac_canvas",
      name: "inbox-zero-app-key",
      status: "ENABLED",
      created_at: "2026-01-01T00:00:00Z",
    });
    api.state.accounts.push(
      account("ca_old", "email-account-1", "ac_canvas", "ACTIVE", "2026-01"),
    );

    await composioProvider.connectWithCredentials({
      app: "app-key",
      authScheme: "API_KEY",
      emailAccountId: "email-account-1",
      credentials: {
        full: "https://canvas.example.edu",
        generic_api_key: "good-token",
      },
      verifyTool: "APP_LIST",
    });

    // The new connection replaces the old one.
    expect(api.state.accounts.map((a) => a.id)).toEqual(["ca_2"]);
  });

  it("keeps nothing when the app rejects the key", async () => {
    await expect(
      composioProvider.connectWithCredentials({
        app: "app-bad-key",
        authScheme: "API_KEY",
        emailAccountId: "email-account-1",
        credentials: {
          full: "https://canvas.example.edu",
          generic_api_key: "wrong",
        },
        verifyTool: "APP_LIST",
      }),
    ).rejects.toBeInstanceOf(CredentialsRejectedError);

    expect(api.state.accounts).toEqual([]);
    // Key-based apps get a custom auth config, not Composio-managed OAuth.
    expect(api.state.authConfigTypes.get("inbox-zero-app-bad-key")).toBe(
      "use_custom_auth",
    );
  });

  async function createAuthConfig(app: string) {
    await composioProvider.getConnectUrl({
      app,
      emailAccountId: "email-account-1",
      callbackUrl: "http://localhost:3000/callback",
    });
    return api.state.authConfigs.find(
      (config) => config.name === `inbox-zero-${app}`,
    )!.id;
  }
});

function account(
  id: string,
  userId: string,
  authConfigId: string,
  status: string,
  createdAt: string,
) {
  return {
    id,
    user_id: userId,
    auth_config_id: authConfigId,
    status,
    created_at: createdAt,
  };
}

function createFakeComposioApi() {
  const state = {
    authConfigs: [] as {
      id: string;
      name: string;
      status: string;
      created_at: string;
    }[],
    servers: [] as {
      id: string;
      name: string;
      mcp_url: string;
      auth_config_ids: string[];
      allowed_tools: string[];
    }[],
    accounts: [] as ReturnType<typeof account>[],
    authConfigTypes: new Map<string, string>(),
    validKeys: new Set<string>(),
    keysByAccount: new Map<string, string>(),
  };

  const fetch = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(input.toString());
    const path = url.pathname.replace("/api/v3", "");
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(init.body.toString()) : undefined;

    if (method === "GET" && path === "/auth_configs") {
      return json({ items: state.authConfigs });
    }
    if (method === "POST" && path === "/auth_configs") {
      const id = `ac_${state.authConfigs.length + 1}`;
      state.authConfigs.push({
        id,
        name: body.auth_config.name,
        status: "ENABLED",
        created_at: new Date().toISOString(),
      });
      state.authConfigTypes.set(body.auth_config.name, body.auth_config.type);
      return json({ auth_config: { id } });
    }
    if (method === "POST" && path === "/connected_accounts") {
      const id = `ca_${state.accounts.length + 1}`;
      state.accounts.push(
        account(
          id,
          body.connection.user_id,
          body.auth_config.id,
          "ACTIVE",
          new Date().toISOString(),
        ),
      );
      state.keysByAccount.set(id, body.connection.state.val.generic_api_key);
      return json({ id, status: "ACTIVE" });
    }
    if (method === "POST" && path.startsWith("/tools/execute/")) {
      const key = state.keysByAccount.get(body.connected_account_id) ?? "";
      return state.validKeys.has(key)
        ? json({ data: { items: [] }, successful: true, error: null })
        : json({ data: {}, successful: false, error: "401 Unauthorized" });
    }
    if (method === "GET" && path === "/mcp/servers") {
      return json({
        items: state.servers.filter(
          (server) => server.name === url.searchParams.get("name"),
        ),
      });
    }
    if (method === "POST" && path === "/mcp/servers") {
      const id = `server-${state.servers.length + 1}`;
      const server = {
        id,
        name: body.name,
        mcp_url: `https://mcp.example.com/${id}`,
        auth_config_ids: body.auth_config_ids,
        allowed_tools: body.allowed_tools,
      };
      state.servers.push(server);
      return json(server);
    }
    if (method === "PATCH" && path.startsWith("/mcp/")) {
      const server = state.servers.find((s) => path.endsWith(s.id))!;
      server.allowed_tools = body.allowed_tools;
      return json(server);
    }
    if (method === "POST" && path === "/connected_accounts/link") {
      return json({ redirect_url: "https://connect.composio.dev/link/lk_1" });
    }
    if (method === "GET" && path === "/connected_accounts") {
      return json({
        items: state.accounts.filter(
          (item) =>
            item.user_id === url.searchParams.get("user_ids") &&
            item.auth_config_id === url.searchParams.get("auth_config_ids"),
        ),
      });
    }
    if (method === "DELETE" && path.startsWith("/connected_accounts/")) {
      state.accounts = state.accounts.filter((item) => !path.endsWith(item.id));
      return json({ success: true });
    }

    return new Response("Not found", { status: 404 });
  });

  return { state, fetch };
}

function json(data: unknown) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
