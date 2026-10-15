import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  COMPOSIO_TOOL_CATALOG,
  type ComposioEmulator,
  createComposioEmulator,
} from "@/__tests__/emulators/composio";
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";
import { composioProvider } from "@/utils/mcp/providers/composio";

const env = vi.hoisted(() => ({ COMPOSIO_API_KEY: "", COMPOSIO_API_URL: "" }));

vi.mock("@/env", () => ({ env }));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
  },
}));

const composioApps = Object.values(MCP_INTEGRATIONS).filter(
  (integration) => integration.provider?.id === "composio",
);

let emulator: ComposioEmulator;

beforeAll(async () => {
  emulator = await createComposioEmulator();
  env.COMPOSIO_API_KEY = emulator.apiKey;
  env.COMPOSIO_API_URL = emulator.url;
});

afterAll(async () => {
  await emulator.close();
});

describe("Composio allowlists", () => {
  it.each(
    composioApps.map((integration) => [integration.name, integration] as const),
  )("%s only allows tools Composio publishes", async (_name, integration) => {
    const { app, authScheme } = integration.provider!;
    const catalog = COMPOSIO_TOOL_CATALOG[app] ?? [];
    const allowedTools = integration.allowedTools ?? [];

    expect(allowedTools.filter((tool) => !catalog.includes(tool))).toEqual([]);
    for (const tool of allowedTools) {
      // Tools with an argument contract refuse empty args, which still proves
      // Composio publishes them; an unpublished slug never reaches that check.
      const outcome = await composioProvider
        .executeTool({
          app,
          authScheme,
          emailAccountId: "email-account-1",
          tool,
          args: {},
        })
        .catch((error: Error) => error);
      if (outcome instanceof Error) {
        expect(outcome.message).toMatch(/is required|must be a|at least one/);
      } else {
        expect(outcome).toBeDefined();
      }
    }
  });

  it.each([
    [
      "clickup",
      [
        "CLICKUP_GET_FILTERED_TEAM_TASKS",
        "CLICKUP_GET_TASK",
        "CLICKUP_GET_TASK_COMMENTS",
        "CLICKUP_GET_AUTHORIZED_TEAMS_WORKSPACES",
      ],
    ],
    [
      "calendly",
      [
        "CALENDLY_LIST_SCHEDULED_EVENTS",
        "CALENDLY_GET_EVENT",
        "CALENDLY_LIST_EVENT_INVITEES",
        "CALENDLY_GET_EVENT_INVITEE",
        "CALENDLY_GET_USER",
      ],
    ],
    [
      "microsoft_teams",
      [
        "MICROSOFT_TEAMS_CHATS_GET_ALL_CHATS",
        "MICROSOFT_TEAMS_CHATS_GET_ALL_MESSAGES",
        "MICROSOFT_TEAMS_GET_CHAT_MESSAGE",
      ],
    ],
    [
      "asana",
      [
        "ASANA_SEARCH_TASKS_IN_WORKSPACE",
        "ASANA_GET_MULTIPLE_WORKSPACES",
        "ASANA_GET_A_TASK",
        "ASANA_GET_TASKS_FROM_A_PROJECT",
        "ASANA_GET_WORKSPACE_PROJECTS",
        "ASANA_GET_A_USER_TASK_LIST",
        "ASANA_GET_TASKS_FOR_USER_TASK_LIST",
      ],
    ],
    [
      "zendesk",
      [
        "ZENDESK_SEARCH_ZENDESK",
        "ZENDESK_SEARCH_ZENDESK_USERS",
        "ZENDESK_GET_USERS_REQUESTED_TICKETS",
        "ZENDESK_GET_ZENDESK_TICKET_BY_ID",
        "ZENDESK_GET_TICKET_COMMENTS",
        "ZENDESK_GET_ZENDESK_ORGANIZATION",
        "ZENDESK_GET_USERS_REQUESTS",
        "ZENDESK_GET_REQUESTS_SEARCH",
        "ZENDESK_GET_REQUEST_COMMENTS",
      ],
    ],
    [
      "salesforce",
      [
        "SALESFORCE_SEARCH_CONTACTS",
        "SALESFORCE_SEARCH_ACCOUNTS",
        "SALESFORCE_SEARCH_LEADS",
        "SALESFORCE_SEARCH_OPPORTUNITIES",
        "SALESFORCE_GET_CONTACT",
        "SALESFORCE_GET_ACCOUNT",
        "SALESFORCE_GET_OPPORTUNITY",
        "SALESFORCE_GET_LEAD",
      ],
    ],
  ])("%s allows exactly its read tools", (name, tools) => {
    expect([...(MCP_INTEGRATIONS[name].allowedTools ?? [])].sort()).toEqual(
      [...tools].sort(),
    );
  });
});
