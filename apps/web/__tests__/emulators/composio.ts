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
 * The tools Cue fetches a linked item or the sender's record with (Drive file
 * metadata, Jira, Asana and ClickUp lookups, HubSpot and Salesforce people
 * searches) refuse arguments their Composio docs don't list. Other tools in COMPOSIO_TOOL_CATALOG answer with no data; any other slug is
 * unknown, as a retired one is to Composio.
 *
 * Fidelity caveat: tool results are the shapes Cue's parsers read, seeded by
 * the caller, so this catches regressions in Cue's own code, not a misreading
 * of the apps' APIs.
 */

const DEFAULT_API_KEY = "emulator-composio-key";

/**
 * Read-only tool slugs Composio publishes for the apps Cue connects, checked
 * by hand against docs.composio.dev/toolkits/<app> (2026-10-14). Composio
 * renames and retires slugs, and a missing one silently drops the tool, so
 * the registry's allowlists are tested against this snapshot.
 */
export const COMPOSIO_TOOL_CATALOG: Record<string, string[]> = {
  airtable: [
    "AIRTABLE_GET_BASE_SCHEMA",
    "AIRTABLE_GET_RECORD",
    "AIRTABLE_LIST_BASES",
    "AIRTABLE_LIST_RECORDS",
  ],
  asana: [
    "ASANA_GET_A_TASK",
    "ASANA_GET_A_USER_TASK_LIST",
    "ASANA_GET_MULTIPLE_WORKSPACES",
    "ASANA_GET_TASKS_FOR_USER_TASK_LIST",
    "ASANA_GET_TASKS_FROM_A_PROJECT",
    "ASANA_GET_WORKSPACE_PROJECTS",
    "ASANA_SEARCH_TASKS_IN_WORKSPACE",
  ],
  calendly: [
    "CALENDLY_GET_EVENT",
    "CALENDLY_GET_EVENT_INVITEE",
    "CALENDLY_GET_USER",
    "CALENDLY_LIST_EVENT_INVITEES",
    "CALENDLY_LIST_SCHEDULED_EVENTS",
  ],
  canvas: [
    "CANVAS_GET_ALL_ASSIGNMENTS",
    "CANVAS_GET_CURRENT_USER",
    "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
    "CANVAS_LIST_COURSES",
    "CANVAS_LIST_DISCUSSION_TOPICS",
  ],
  clickup: [
    "CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES",
    "CLICKUP_GET_FILTERED_TEAM_TASKS",
    "CLICKUP_GET_TASK",
    "CLICKUP_GET_TASK_COMMENTS",
  ],
  googledrive: ["GOOGLEDRIVE_FIND_FILE", "GOOGLEDRIVE_GET_FILE_METADATA"],
  googlesheets: [
    "GOOGLESHEETS_BATCH_GET",
    "GOOGLESHEETS_GET_SPREADSHEET_INFO",
    "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW",
    "GOOGLESHEETS_SEARCH_SPREADSHEETS",
  ],
  hubspot: [
    "HUBSPOT_GET_ACCOUNT_INFO",
    "HUBSPOT_GET_COMPANY",
    "HUBSPOT_GET_DEAL",
    "HUBSPOT_GET_TICKET",
    "HUBSPOT_READ_CONTACT",
    "HUBSPOT_SEARCH_COMPANIES",
    "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
    "HUBSPOT_SEARCH_DEALS",
    "HUBSPOT_SEARCH_TICKETS",
  ],
  jira: [
    "JIRA_GET_ALL_PROJECTS",
    "JIRA_GET_ISSUE",
    "JIRA_LIST_ISSUE_COMMENTS",
    "JIRA_SEARCH_ISSUES",
  ],
  microsoft_teams: [
    "MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS",
    // Deprecated by Composio for LIST_USER_CHAT_MESSAGES, which documents
    // only an id or UPN for the user, not "me"
    "MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES",
    "MICROSOFT_TEAMS_GET_CHAT_MESSAGE",
  ],
  one_drive: [
    "ONE_DRIVE_DOWNLOAD_FILE",
    "ONE_DRIVE_GET_ITEM",
    "ONE_DRIVE_SEARCH_ITEMS",
  ],
  quickbooks: [
    "QUICKBOOKS_CUSTOMER_BALANCE_REPORT",
    "QUICKBOOKS_QUERY_CUSTOMERS",
    "QUICKBOOKS_QUERY_INVOICES",
    "QUICKBOOKS_READ_CUSTOMER",
  ],
  salesforce: [
    "SALESFORCE_GET_ACCOUNT",
    "SALESFORCE_GET_CONTACT",
    "SALESFORCE_GET_LEAD",
    "SALESFORCE_GET_OPPORTUNITY",
    "SALESFORCE_GET_USER_INFO",
    "SALESFORCE_SEARCH_ACCOUNTS",
    "SALESFORCE_SEARCH_CONTACTS",
    "SALESFORCE_SEARCH_LEADS",
    "SALESFORCE_SEARCH_OPPORTUNITIES",
  ],
  slack: [
    "SLACK_FETCH_MESSAGE_THREAD_FROM_A_CONVERSATION",
    "SLACK_FIND_CHANNELS",
    "SLACK_FIND_USER_BY_EMAIL_ADDRESS",
    "SLACK_SEARCH_MESSAGES",
  ],
  zendesk: [
    "ZENDESK_GET_REQUEST_COMMENTS",
    "ZENDESK_GET_REQUESTS_SEARCH",
    "ZENDESK_GET_TICKET_COMMENTS",
    "ZENDESK_GET_USERS_REQUESTED_TICKETS",
    "ZENDESK_GET_USERS_REQUESTS",
    "ZENDESK_GET_ZENDESK_ORGANIZATION",
    "ZENDESK_GET_ZENDESK_TICKET_BY_ID",
    "ZENDESK_SEARCH_ZENDESK",
    "ZENDESK_SEARCH_ZENDESK_USERS",
  ],
};
const CATALOGUED_TOOLS = new Set(Object.values(COMPOSIO_TOOL_CATALOG).flat());
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

/** A Jira issue as `GET /rest/api/3/issue/{key}` returns it. */
export type ComposioEmulatorJiraIssue = {
  key: string;
  /** The issue's own API URL, which names its site. */
  self: string;
  fields: {
    summary: string;
    status: { name: string };
    assignee: { displayName: string; emailAddress: string } | null;
    priority: { name: string };
    updated: string;
  };
};

/** An Asana task, without the `data` wrapper. */
export type ComposioEmulatorAsanaTask = {
  gid: string;
  name: string;
  completed: boolean;
  due_on: string | null;
  assignee: { name: string } | null;
  permalink_url: string;
  modified_at: string;
};

export type ComposioEmulatorClickUpTask = {
  id: string;
  name: string;
  status: { status: string };
  assignees: { username: string; email: string }[];
  /** Milliseconds since the epoch. */
  date_updated: string;
  url: string;
};

export type ComposioEmulatorHubSpotContact = {
  id: string;
  properties: Record<string, string>;
};

/** A Salesforce Contact or Lead record. */
export type ComposioEmulatorSalesforcePerson = {
  Id: string;
  Name: string;
  Email: string;
  Title?: string;
  Company?: string;
  Status?: string;
  Account?: { Name: string };
  LastModifiedDate?: string;
};

export interface ComposioEmulatorOptions {
  apiKey?: string;
  asanaTasks?: ComposioEmulatorAsanaTask[];
  canvasEvents?: ComposioEmulatorCanvasEvent[];
  clickupTasks?: ComposioEmulatorClickUpTask[];
  driveFiles?: ComposioEmulatorDriveFile[];
  /** What HUBSPOT_GET_ACCOUNT_INFO answers for the connected portal. */
  hubspotAccount?: Record<string, unknown>;
  hubspotContacts?: ComposioEmulatorHubSpotContact[];
  jiraIssues?: ComposioEmulatorJiraIssue[];
  port?: number;
  salesforceContacts?: ComposioEmulatorSalesforcePerson[];
  salesforceLeads?: ComposioEmulatorSalesforcePerson[];
  /** What SALESFORCE_GET_USER_INFO answers for the connected user. */
  salesforceUserInfo?: Record<string, unknown>;
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
  const jiraIssues = options.jiraIssues ?? [];
  const asanaTasks = options.asanaTasks ?? [];
  const clickupTasks = options.clickupTasks ?? [];
  const hubspotContacts = options.hubspotContacts ?? [];
  const salesforceContacts = options.salesforceContacts ?? [];
  const salesforceLeads = options.salesforceLeads ?? [];
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
    GOOGLEDRIVE_GET_FILE_METADATA: (args) => {
      checkArgs("GOOGLEDRIVE_GET_FILE_METADATA", args, {
        required: { fileId: "string" },
        optional: {
          fields: "string",
          includeLabels: "string",
          supportsAllDrives: "boolean",
          includePermissionsForView: "string",
        },
      });
      const file = driveFiles.find((f) => f.id === args.fileId);
      if (!file) throw new ToolFailure(`404: File not found: ${args.fileId}`);
      return file;
    },
    JIRA_GET_ISSUE: (args) => {
      checkArgs("JIRA_GET_ISSUE", args, {
        required: { issue_id_or_key: "string" },
        optional: {
          expand: "string",
          fields: "array",
          fail_fast: "boolean",
          properties: "array",
          fields_by_keys: "boolean",
          update_history: "boolean",
        },
      });
      const issue = jiraIssues.find((i) => i.key === args.issue_id_or_key);
      if (!issue) {
        throw new ToolFailure(
          "404: Issue does not exist or you do not have permission to see it.",
        );
      }
      return issue;
    },
    ASANA_GET_A_TASK: (args) => {
      checkArgs("ASANA_GET_A_TASK", args, {
        required: { task_gid: "string" },
        optional: { opt_fields: "array", opt_pretty: "boolean" },
      });
      const task = asanaTasks.find((t) => t.gid === args.task_gid);
      if (!task) throw new ToolFailure("404: Not Found");
      return { data: task };
    },
    // Composio documents only task_id as required; team_id (with
    // custom_task_ids) is for custom ids, which this emulator doesn't model.
    CLICKUP_GET_TASK: (args) => {
      checkArgs("CLICKUP_GET_TASK", args, {
        required: { task_id: "string" },
      });
      const task = clickupTasks.find((t) => t.id === args.task_id);
      if (!task) throw new ToolFailure("404: Task not found");
      return task;
    },
    // HubSpot's CRM search: filters in a group are ANDed, groups ORed; at
    // most 100 results.
    HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: (args) => {
      checkArgs("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA", args, {
        required: { filterGroups: "array" },
        optional: { properties: "array", limit: "number" },
      });
      if (Number(args.limit ?? 10) > 100) {
        throw new ToolFailure("400: limit must be at most 100");
      }
      return {
        results: hubspotContacts
          .filter((contact) =>
            hubspotFilterGroups(args.filterGroups).some((filters) =>
              filters.every((filter) => matchesHubSpotFilter(contact, filter)),
            ),
          )
          .slice(0, Number(args.limit ?? 10)),
      };
    },
    // Composio documents no inputs and describes the answer only as
    // "email, hubId, user details", so the seed is what Cue's parser reads.
    HUBSPOT_GET_ACCOUNT_INFO: (args) => {
      checkArgs("HUBSPOT_GET_ACCOUNT_INFO", args, {
        required: {},
        optional: {},
      });
      return options.hubspotAccount ?? {};
    },
    SALESFORCE_GET_USER_INFO: (args) => {
      checkArgs("SALESFORCE_GET_USER_INFO", args, {
        required: {},
        optional: { user_id: "string", include_permissions: "boolean" },
      });
      return options.salesforceUserInfo ?? {};
    },
    // Composio: "All parameters support partial/fuzzy matching"; at least
    // one criterion.
    SALESFORCE_SEARCH_CONTACTS: (args) =>
      searchSalesforcePeople("SALESFORCE_SEARCH_CONTACTS", args, [
        ...salesforceContacts,
      ]),
    SALESFORCE_SEARCH_LEADS: (args) =>
      searchSalesforcePeople("SALESFORCE_SEARCH_LEADS", args, [
        ...salesforceLeads,
      ]),
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
      const tool =
        (tools[toolMatch[1]] as (typeof tools)[string] | undefined) ??
        (CATALOGUED_TOOLS.has(toolMatch[1]) ? () => ({}) : undefined);
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

type ArgType = "string" | "number" | "boolean" | "array" | "any";

/**
 * Refuses arguments outside a tool's documented inputs, as Composio does when
 * they fail its schema: a missing or mistyped required one, or one it
 * doesn't take. `optional` omitted means unknown arguments aren't checked.
 */
function checkArgs(
  tool: string,
  args: Record<string, unknown>,
  {
    required,
    optional,
  }: {
    required: Record<string, ArgType>;
    optional?: Record<string, ArgType>;
  },
) {
  const known = { ...required, ...optional };
  for (const [name, value] of Object.entries(args)) {
    if (optional && !(name in known)) {
      throw new ToolFailure(`${tool}: unknown argument ${name}`);
    }
    if (name in known && !isArgType(value, known[name]!)) {
      throw new ToolFailure(`${tool}: ${name} must be a ${known[name]}`);
    }
  }
  for (const name of Object.keys(required)) {
    if (args[name] === undefined || args[name] === "") {
      throw new ToolFailure(`${tool}: ${name} is required`);
    }
  }
}

function isArgType(value: unknown, type: ArgType) {
  if (type === "any") return true;
  return type === "array" ? Array.isArray(value) : typeof value === type;
}

type HubSpotFilter = { propertyName: string; operator: string; value: string };

/** Only EQ is modelled; anything else is refused rather than guessed. */
function hubspotFilterGroups(value: unknown): HubSpotFilter[][] {
  const groups = value as { filters?: unknown }[];
  return groups.map((group) => {
    if (!Array.isArray(group?.filters)) {
      throw new ToolFailure("400: each filter group needs filters");
    }
    return group.filters.map((filter: Partial<HubSpotFilter>) => {
      if (
        typeof filter.propertyName !== "string" ||
        filter.operator !== "EQ" ||
        typeof filter.value !== "string"
      ) {
        throw new ToolFailure(
          "400: filters need propertyName, operator EQ and a value",
        );
      }
      return filter as HubSpotFilter;
    });
  });
}

// HubSpot compares email values without case.
function matchesHubSpotFilter(
  contact: ComposioEmulatorHubSpotContact,
  filter: HubSpotFilter,
) {
  return (
    contact.properties[filter.propertyName]?.toLowerCase() ===
    filter.value.toLowerCase()
  );
}

function searchSalesforcePeople(
  tool: "SALESFORCE_SEARCH_CONTACTS" | "SALESFORCE_SEARCH_LEADS",
  args: Record<string, unknown>,
  people: ComposioEmulatorSalesforcePerson[],
) {
  const criteria =
    tool === "SALESFORCE_SEARCH_CONTACTS"
      ? ["name", "email", "phone", "title", "account_name"]
      : ["name", "email", "phone", "title", "company", "status", "lead_source"];
  checkArgs(tool, args, {
    required: {},
    optional: {
      ...Object.fromEntries(criteria.map((name) => [name, "string" as const])),
      // Documented without a type.
      fields: "any",
      limit: "number",
    },
  });
  if (!criteria.some((name) => args[name])) {
    throw new ToolFailure(`${tool}: provide at least one search criterion`);
  }
  const email = String(args.email ?? "").toLowerCase();
  const records = people
    .filter((person) => person.Email.toLowerCase().includes(email))
    .slice(0, Number(args.limit ?? 25));
  return { totalSize: records.length, records };
}

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

function words(text: string): string[] {
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
