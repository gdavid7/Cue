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
 * Tools enforce the argument rules the apps document where Cue has tripped on
 * them: Drive refuses to sort a full-text search, and Canvas lists only the
 * personal calendar unless it is given course context codes (at most 10).
 *
 * Fidelity caveat: tool results are the shapes Cue's parsers read, seeded by
 * the caller, so this catches regressions in Cue's own code, not a misreading
 * of the apps' APIs.
 */

const DEFAULT_API_KEY = "emulator-composio-key";
const CANVAS_USER_ID = 4211;
const DRIVE_FOLDER = "application/vnd.google-apps.folder";

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
  /** The course it belongs to, as `course_<id>`. */
  context_code: string;
  context_name: string;
  assignment: { due_at: string; description: string; html_url: string };
};

/** A match from Slack's `search.messages`. */
export type ComposioEmulatorSlackMessage = {
  text: string;
  ts: string;
  username: string;
  permalink: string;
  channel: { id: string; name: string };
};

export interface ComposioEmulatorOptions {
  apiKey?: string;
  canvasEvents?: ComposioEmulatorCanvasEvent[];
  driveFiles?: ComposioEmulatorDriveFile[];
  port?: number;
  slackMessages?: ComposioEmulatorSlackMessage[];
}

export interface ComposioEmulator {
  apiKey: string;
  close(): Promise<void>;
  /** A user's connected accounts, oldest first. */
  connectedAccounts(userId: string): ConnectedAccount[];
  /**
   * Marks a user's accounts EXPIRED, as Composio does when it can no longer
   * refresh the app's token.
   */
  expireConnections(userId: string): void;
  /**
   * Makes a tool fail from now on: `revoked` answers as Composio does once
   * the app's token is revoked (unsuccessful, with the app's auth error);
   * `server_error` answers HTTP 500. `null` makes it work again.
   */
  failTool(slug: string, how: "revoked" | "server_error" | null): void;
  /** Every tool execution, in order. */
  toolCalls: { tool: string; connectedAccountId: string }[];
  /** The v3 base URL, for `COMPOSIO_API_URL`. */
  url: string;
}

type RequestBody = {
  arguments?: Record<string, unknown>;
  auth_config?: { id?: string; name?: string };
  connected_account_id?: string;
  connection?: { user_id?: string };
  filename?: string;
  toolkit?: { slug?: string };
};

type ConnectedAccount = {
  id: string;
  user_id: string;
  auth_config_id: string;
  status: "ACTIVE" | "EXPIRED";
  created_at: string;
};

// Accounts are stamped a second apart so "newest" is never a tie.
const EPOCH = Date.parse("2026-01-01T00:00:00Z");

export async function createComposioEmulator(
  options: ComposioEmulatorOptions = {},
): Promise<ComposioEmulator> {
  const apiKey = options.apiKey ?? DEFAULT_API_KEY;
  const driveFiles = options.driveFiles ?? [];
  const canvasEvents = options.canvasEvents ?? [];
  const slackMessages = options.slackMessages ?? [];
  const failingTools = new Map<string, "revoked" | "server_error">();
  const toolCalls: ComposioEmulator["toolCalls"] = [];

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
    const id = ++sequence;
    const account: ConnectedAccount = {
      id: `ca_emulated_${id}`,
      user_id: userId,
      auth_config_id: authConfigId,
      status: "ACTIVE",
      created_at: new Date(EPOCH + id * 1000).toISOString(),
    };
    accounts.set(account.id, account);
    return account;
  }

  const tools: Record<string, (args: Record<string, unknown>) => unknown> = {
    GOOGLEDRIVE_FIND_FILE: (args) => {
      const query = String(args.q ?? "");
      // Drive answers 403 to this, and Composio's FIND_FILE docs say orderBy
      // "cannot be used when query (q) contains fullText search terms".
      if (args.orderBy && query.includes("fullText")) {
        throw new ToolFailure(
          "403: Sorting is not supported for queries with fullText terms. Results are always in descending relevance order.",
        );
      }
      return { files: searchDriveFiles(driveFiles, query) };
    },
    ONE_DRIVE_SEARCH_ITEMS: () => ({ value: [] }),
    CANVAS_GET_CURRENT_USER: () => ({
      response_data: { id: CANVAS_USER_ID, name: "Emulated student" },
    }),
    CANVAS_LIST_COURSES: () => ({
      response_data: canvasCourses(canvasEvents),
    }),
    // Canvas docs: context_codes "if not specified, defaults to the current
    // user (i.e personal calendar, no course/group events)"; at most 10.
    CANVAS_LIST_CALENDAR_EVENTS_FOR_USER: (args) => {
      const codes = Array.isArray(args.context_codes)
        ? args.context_codes.map(String)
        : [];
      if (codes.length > 10) {
        throw new ToolFailure("400: at most 10 context_codes are allowed");
      }
      return {
        response_data: canvasEvents.filter((event) =>
          codes.includes(event.context_code),
        ),
      };
    },
    SLACK_SEARCH_MESSAGES: (args) => ({
      ok: true,
      query: String(args.query ?? ""),
      messages: {
        matches: searchSlackMessages(slackMessages, String(args.query ?? "")),
      },
    }),
    // A saved file joins the drive, so it can turn up as context afterwards.
    GOOGLEDRIVE_UPLOAD_FILE: (args) => {
      const file = uploadedFile(args.file_to_upload, "drive");
      driveFiles.push({
        id: file.id,
        name: file.name,
        mimeType: file.mimetype,
        modifiedTime: new Date().toISOString(),
        webViewLink: `https://drive.google.com/file/d/${file.id}/view`,
        owners: [],
      });
      return {
        id: file.id,
        name: file.name,
        webViewLink: `https://drive.google.com/file/d/${file.id}/view`,
      };
    },
    ONE_DRIVE_ONEDRIVE_UPLOAD_FILE: (args) => {
      const file = uploadedFile(args.file, "onedrive");
      return {
        id: file.id,
        name: file.name,
        webUrl: `https://onedrive.live.com/?id=${file.id}`,
      };
    },
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
    // An upload's body is the file itself, not JSON.
    if (path.startsWith("/__uploads/") && method === "PUT") {
      response.writeHead(200);
      return response.end();
    }
    const body: RequestBody = raw ? JSON.parse(raw) : {};

    if (path === "/health") return respondJson(response, 200, { ok: true });

    // Files reach tools through Composio's storage: request a slot, then PUT.
    if (path === "/files/upload/request" && method === "POST") {
      const key = `emulated/${++sequence}/${body.filename ?? "file"}`;
      return respondJson(response, 200, {
        key,
        new_presigned_url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/__uploads/${encodeURIComponent(key)}`,
        type: "new",
        metadata: { storage_backend: "s3" },
      });
    }

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
      const connectedAccountId = String(body.connected_account_id);
      toolCalls.push({ tool: toolMatch[1], connectedAccountId });
      const account = accounts.get(connectedAccountId);
      if (account?.status !== "ACTIVE") {
        return respondJson(response, 200, {
          data: {},
          successful: false,
          error: account
            ? `Connected account is ${account.status}`
            : "Connected account not found",
        });
      }
      const failure = failingTools.get(toolMatch[1]);
      if (failure === "server_error") {
        return respondJson(response, 500, {
          error: { message: "Internal server error" },
        });
      }
      if (tool && failure === "revoked") {
        return respondJson(response, 200, {
          data: {},
          successful: false,
          error: "401 Unauthorized: invalid_grant",
        });
      }
      if (tool) {
        try {
          return respondJson(response, 200, {
            data: tool(body.arguments ?? {}),
            successful: true,
            error: null,
          });
        } catch (error) {
          if (!(error instanceof ToolFailure)) throw error;
          return respondJson(response, 200, {
            data: {},
            successful: false,
            error: error.message,
          });
        }
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
    connectedAccounts: (userId) =>
      [...accounts.values()].filter((account) => account.user_id === userId),
    expireConnections: (userId) => {
      for (const account of accounts.values()) {
        if (account.user_id === userId) account.status = "EXPIRED";
      }
    },
    failTool: (slug, how) => {
      if (how) failingTools.set(slug, how);
      else failingTools.delete(slug);
    },
    toolCalls,
    url: `http://127.0.0.1:${port}/api/v3`,
  };
}

/** A call the app itself rejected, which Composio reports as unsuccessful. */
class ToolFailure extends Error {}

/** The courses the seeded assignments belong to. */
function canvasCourses(events: ComposioEmulatorCanvasEvent[]) {
  const courses = new Map<number, { id: number; name: string }>();
  for (const event of events) {
    const id = Number(event.context_code.replace(/^course_/, ""));
    courses.set(id, { id, name: event.context_name });
  }
  return [...courses.values()];
}

/** Slack matches every word of the query. */
function searchSlackMessages(
  messages: ComposioEmulatorSlackMessage[],
  query: string,
) {
  const terms = words(query);
  return messages.filter((message) => {
    const text = words(message.text);
    return terms.every((term) => text.includes(term));
  });
}

function uploadedFile(value: unknown, prefix: string) {
  const file = (value ?? {}) as { name?: string; mimetype?: string };
  return {
    id: `${prefix}-${Math.random().toString(36).slice(2, 10)}`,
    name: file.name ?? "file",
    mimetype: file.mimetype ?? "application/octet-stream",
  };
}

/**
 * Files whose name shares a word with any `fullText contains '...'` term,
 * without folders when the query leaves them out.
 */
function searchDriveFiles(files: ComposioEmulatorDriveFile[], query: string) {
  const noFolders = query.includes(`mimeType != '${DRIVE_FOLDER}'`);
  const terms = [...query.matchAll(/contains '((?:[^'\\]|\\.)*)'/g)].flatMap(
    ([, term]) => words(term.replace(/\\(.)/g, "$1")),
  );
  return files.filter(
    (file) =>
      !(noFolders && file.mimeType === DRIVE_FOLDER) &&
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
