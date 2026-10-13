import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A local stand-in for Composio's v3 API, in the spirit of the Stripe and LLM
 * emulators next to it. It answers only what Cue's Composio provider calls:
 * auth configs, connected accounts, and tool execution for the tools Cue reads
 * connected-app context with.
 *
 * Every account starts out connected to every app, so a demo only has to
 * record the connection on its own side. Disconnecting deletes the account,
 * and connecting with credentials creates a new one, as Composio does.
 *
 * Fidelity caveat: tool results are the shapes Cue's parsers read, seeded by
 * the caller, so this catches regressions in Cue's own code, not a misreading
 * of the apps' APIs.
 */

const DEFAULT_API_KEY = "emulator-composio-key";
const CANVAS_USER_ID = 4211;

export type ComposioEmulatorDriveFile = {
  id: string;
  name: string;
  mimeType: string;
  modifiedTime: string;
  webViewLink: string;
  owners: { displayName: string; emailAddress: string }[];
};

/** A Canvas calendar event of type `assignment`. */
export type ComposioEmulatorCanvasEvent = {
  id: number;
  title: string;
  description: string;
  start_at: string;
  end_at: string;
  html_url: string;
  context_name: string;
  assignment: { due_at: string; description: string; html_url: string };
};

export interface ComposioEmulatorOptions {
  apiKey?: string;
  canvasEvents?: ComposioEmulatorCanvasEvent[];
  driveFiles?: ComposioEmulatorDriveFile[];
  port?: number;
}

export interface ComposioEmulator {
  apiKey: string;
  close(): Promise<void>;
  /** The v3 base URL, for `COMPOSIO_API_URL`. */
  url: string;
}

type RequestBody = {
  arguments?: Record<string, unknown>;
  auth_config?: { id?: string; name?: string };
  connected_account_id?: string;
  connection?: { user_id?: string };
  toolkit?: { slug?: string };
};

type ConnectedAccount = {
  id: string;
  user_id: string;
  auth_config_id: string;
  status: "ACTIVE";
  created_at: string;
};

export async function createComposioEmulator(
  options: ComposioEmulatorOptions = {},
): Promise<ComposioEmulator> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const driveFiles = options.driveFiles ?? [];
  const canvasEvents = options.canvasEvents ?? [];

  const authConfigs: {
    id: string;
    toolkit: string;
    name: string;
    status: "ENABLED";
    created_at: string;
  }[] = [];
  const accounts = new Map<string, ConnectedAccount>();
  // (user, auth config) pairs already given their default connection, so a
  // deleted one stays deleted.
  const seenPairs = new Set<string>();
  let sequence = 0;

  function createAccount(userId: string, authConfigId: string) {
    const account: ConnectedAccount = {
      id: `ca_emulated_${++sequence}`,
      user_id: userId,
      auth_config_id: authConfigId,
      status: "ACTIVE",
      created_at: new Date().toISOString(),
    };
    accounts.set(account.id, account);
    return account;
  }

  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    GOOGLEDRIVE_FIND_FILE: (args) => ({
      files: searchDriveFiles(driveFiles, String(args.q ?? "")),
    }),
    ONE_DRIVE_SEARCH_ITEMS: () => ({ value: [] }),
    CANVAS_GET_CURRENT_USER: () => ({
      response_data: { id: CANVAS_USER_ID, name: "Emulated student" },
    }),
    CANVAS_LIST_CALENDAR_EVENTS_FOR_USER: () => ({
      response_data: canvasEvents,
    }),
    SLACK_SEARCH_MESSAGES: () => ({ messages: { matches: [] } }),
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      respondJson(response, 500, { error: { message: String(error) } });
    });
  });

  async function handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? "/", "http://composio.emulator");
    const method = request.method ?? "GET";
    const path = url.pathname.replace(/^\/api\/v3/, "");
    const raw = await readBody(request);
    const body: RequestBody = raw ? JSON.parse(raw) : {};

    if (path === "/health") return respondJson(response, 200, { ok: true });

    if (request.headers["x-api-key"] !== apiKey) {
      return respondJson(response, 401, {
        error: { message: "Invalid API key" },
      });
    }

    if (path === "/auth_configs" && method === "GET") {
      const toolkit = url.searchParams.get("toolkit_slug");
      return respondJson(response, 200, {
        items: authConfigs.filter((config) => config.toolkit === toolkit),
      });
    }

    if (path === "/auth_configs" && method === "POST") {
      const config = {
        id: `ac_emulated_${++sequence}`,
        toolkit: String(body.toolkit?.slug),
        name: String(body.auth_config?.name),
        status: "ENABLED" as const,
        created_at: new Date().toISOString(),
      };
      authConfigs.push(config);
      return respondJson(response, 200, { auth_config: { id: config.id } });
    }

    if (path === "/connected_accounts" && method === "GET") {
      const userId = url.searchParams.get("user_ids") ?? "";
      const authConfigId = url.searchParams.get("auth_config_ids") ?? "";
      const pair = `${userId}\n${authConfigId}`;
      if (!seenPairs.has(pair)) {
        seenPairs.add(pair);
        createAccount(userId, authConfigId);
      }
      return respondJson(response, 200, {
        items: [...accounts.values()].filter(
          (account) =>
            account.user_id === userId &&
            account.auth_config_id === authConfigId,
        ),
      });
    }

    if (path === "/connected_accounts" && method === "POST") {
      const account = createAccount(
        String(body.connection?.user_id),
        String(body.auth_config?.id),
      );
      return respondJson(response, 200, {
        id: account.id,
        status: account.status,
      });
    }

    const accountMatch = /^\/connected_accounts\/([^/]+)$/.exec(path);
    if (accountMatch && method === "DELETE") {
      accounts.delete(accountMatch[1]);
      return respondJson(response, 200, { success: true });
    }

    const toolMatch = /^\/tools\/execute\/([^/]+)$/.exec(path);
    if (toolMatch && method === "POST") {
      const tool = tools[toolMatch[1]];
      if (!accounts.has(String(body.connected_account_id))) {
        return respondJson(response, 200, {
          data: {},
          successful: false,
          error: "Connected account not found",
        });
      }
      if (tool) {
        return respondJson(response, 200, {
          data: tool(body.arguments ?? {}),
          successful: true,
          error: null,
        });
      }
    }

    return respondJson(response, 404, {
      error: {
        message: `The Composio emulator does not implement ${method} ${path}`,
      },
    });
  }

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? 0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    apiKey,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    url: `http://127.0.0.1:${port}/api/v3`,
  };
}

/** Files whose name shares a word with any `fullText contains '...'` term. */
function searchDriveFiles(files: ComposioEmulatorDriveFile[], query: string) {
  const terms = [...query.matchAll(/contains '((?:[^'\\]|\\.)*)'/g)].flatMap(
    ([, term]) => words(term.replace(/\\(.)/g, "$1")),
  );
  return files.filter((file) =>
    words(file.name).some((word) => terms.includes(word)),
  );
}

function words(text: string) {
  return text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
}

function readBody(request: IncomingMessage) {
  return new Promise<string>((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function respondJson(response: ServerResponse, status: number, body: unknown) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
