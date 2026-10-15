import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCueDemoConnectorData } from "@/__tests__/fixtures/inboxes/cue-demo-inbox";
import {
  composioProvider,
  uploadComposioFile,
} from "@/utils/mcp/providers/composio";
import { ConnectionExpiredError } from "@/utils/mcp/providers/types";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import {
  fetchConnectorCandidates,
  searchCanvas,
  searchGoogleDrive,
  searchOneDrive,
  searchSlack,
} from "@/utils/thread-context/connector-context";
import { type ComposioEmulator, createComposioEmulator } from "./composio";

const env = vi.hoisted(() => ({ COMPOSIO_API_KEY: "", COMPOSIO_API_URL: "" }));

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({ env }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async () => null),
    set: vi.fn(async () => "OK"),
    del: vi.fn(async () => 1),
  },
}));

// A Tuesday; the coming Friday is Oct 16.
const NOW = new Date("2026-10-13T16:00:00Z");
const ACCOUNT = "demo-account";

let emulator: ComposioEmulator;

beforeAll(async () => {
  emulator = await createComposioEmulator({
    ...buildCueDemoConnectorData(NOW),
    jiraIssues: [
      {
        key: "OPS-12",
        self: "https://acme.atlassian.net/rest/api/3/issue/10012",
        fields: {
          summary: "Rotate staging keys",
          status: { name: "In Progress" },
          assignee: {
            displayName: "Nora Patel",
            emailAddress: "nora@acme.com",
          },
          priority: { name: "High" },
          updated: "2026-10-12T09:00:00.000+0000",
        },
      },
    ],
    asanaTasks: [
      {
        gid: "1200000000000001",
        name: "Book the venue",
        completed: false,
        due_on: "2026-10-16",
        assignee: { name: "Kevin Ruiz" },
        permalink_url: "https://app.asana.com/0/0/1200000000000001",
        modified_at: "2026-10-12T10:00:00.000Z",
      },
    ],
    clickupTasks: [
      {
        id: "86abc123",
        name: "Slides for the group project",
        status: { status: "in progress" },
        assignees: [{ username: "Kevin Ruiz", email: "kruiz@ucsd.edu" }],
        date_updated: String(Date.parse("2026-10-12T10:00:00Z")),
        url: "https://app.clickup.com/t/86abc123",
      },
    ],
    hubspotContacts: [
      {
        id: "501",
        properties: {
          email: "Priya@Brightline.io",
          firstname: "Priya",
          lastname: "Nair",
          jobtitle: "Head of Procurement",
          company: "Brightline",
          lifecyclestage: "opportunity",
        },
      },
    ],
    salesforceContacts: [
      // A partial match Salesforce returns for the address below.
      { Id: "003A", Name: "Pri Nair", Email: "priya@brightline.io.old" },
    ],
    salesforceLeads: [
      {
        Id: "00QB",
        Name: "Priya Nair",
        Email: "priya@brightline.io",
        Company: "Brightline",
        Status: "Working",
      },
    ],
    hubspotAccount: { hub_id: 48_211, hub_domain: "brightline.io" },
    salesforceUserInfo: {
      user_id: "005B",
      profile: "https://brightline.my.salesforce.com/005B",
    },
    slackMessages: [
      {
        text: "I'll make the plots for milestone 2 tonight",
        ts: "1791900000.000100",
        username: "kevin",
        permalink: "https://ucsd-cse.slack.com/archives/C1/p1791900000000100",
        channel: { id: "C1", name: "cse151b" },
      },
    ],
  });
  env.COMPOSIO_API_KEY = emulator.apiKey;
  env.COMPOSIO_API_URL = emulator.url;
});

afterAll(async () => {
  await emulator.close();
});

// Goes through the real Composio provider, so a wrong endpoint or envelope
// fails here just as it would in the app.
function executor(app: string, authScheme?: "API_KEY") {
  return (tool: string, args: Record<string, unknown>) =>
    composioProvider.executeTool({
      app,
      authScheme,
      emailAccountId: ACCOUNT,
      tool,
      args,
    });
}

function search(keywords: string[]) {
  return { emailAccountId: ACCOUNT, keywords, now: NOW };
}

describe("Composio emulator with the Cue demo data", () => {
  it("finds the pricing sheet for the renewal thread, owned by Priya", async () => {
    const items = await searchGoogleDrive(
      executor("googledrive"),
      search(["renewal", "discussion", "updated", "pricing"]),
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "file",
        source: "Google Drive",
        title: "Enterprise pricing v3",
        at: new Date(NOW.getTime() - 26 * 3_600_000).toISOString(),
        people: [{ email: "priya@brightline.io", name: "Priya Nair" }],
      }),
    ]);
  });

  it("finds Kevin's write-up for the milestone thread", async () => {
    const items = await searchGoogleDrive(
      executor("googledrive"),
      search(["cse", "151b", "milestone", "kevin's"]),
    );

    expect(items).toEqual([
      expect.objectContaining({
        title: "CSE 151B milestone 2 write-up",
        people: [{ email: "kruiz@ucsd.edu", name: "Kevin Ruiz" }],
      }),
    ]);
  });

  it("lists the milestone assignment due Friday at 11:59pm Pacific", async () => {
    const items = await searchCanvas(
      executor("canvas", "API_KEY"),
      search(["milestone"]),
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "assignment",
        source: "CSE 151B",
        title: "Milestone 2: model evaluation and write-up",
        at: "2026-10-17T06:59:00.000Z",
        // The HTML description arrives as plain text.
        snippet: expect.stringMatching(/^[^<>]+$/),
      }),
    ]);
  });

  it("answers a OneDrive search with no results", async () => {
    await expect(
      searchOneDrive(executor("one_drive"), search(["pricing"])),
    ).resolves.toEqual([]);
  });

  it("finds the Slack message that mentions the thread's words", async () => {
    const items = await searchSlack(
      executor("slack"),
      search(["milestone", "plots", "pricing"]),
    );

    expect(items).toEqual([
      expect.objectContaining({
        kind: "chat",
        title: "#cse151b · kevin",
        url: "https://ucsd-cse.slack.com/archives/C1/p1791900000000100",
      }),
    ]);
  });

  it("stops answering for an app once it is disconnected", async () => {
    const execute = executor("slack");
    await composioProvider.disconnect({
      app: "slack",
      emailAccountId: ACCOUNT,
    });

    await expect(searchSlack(execute, search(["pricing"]))).rejects.toThrow(
      "No active slack connection",
    );
  });
});

describe("Composio emulator with links and the sender in a thread", () => {
  const logger = createScopedLogger("composio-emulator-test");

  function connected(...apps: string[]) {
    prisma.mcpConnection.findMany.mockResolvedValue(
      apps.map((name) => ({
        emailAccountId: ACCOUNT,
        integration: { name },
      })) as never,
    );
  }

  it("turns links to Drive, Jira, Asana and ClickUp into cards", async () => {
    connected("googledrive", "jira", "asana", "clickup");

    const { candidates } = await fetchConnectorCandidates({
      emailAccountId: ACCOUNT,
      keywords: [],
      signals: {
        links: [
          "https://docs.google.com/spreadsheets/d/cue-demo-enterprise-pricing-v3/edit",
          "https://acme.atlassian.net/browse/OPS-12",
          "https://app.asana.com/0/1199999999999999/1200000000000001/f",
          "https://app.clickup.com/t/86abc123",
        ].map((url) => ({ url, messageId: "m1" })),
      },
      logger,
      now: NOW,
    });

    expect(
      candidates.map((c) => [c.source, c.title, c.linkedBy]).sort(),
    ).toEqual([
      ["Asana", "Book the venue", "url"],
      ["ClickUp", "Slides for the group project", "url"],
      ["Google Drive", "Enterprise pricing v3", "url"],
      ["Jira", "OPS-12 Rotate staging keys", "url"],
    ]);
  });

  it("finds the sender in HubSpot, and among Salesforce leads when no contact matches exactly", async () => {
    connected("hubspot", "salesforce");

    const { candidates } = await fetchConnectorCandidates({
      emailAccountId: ACCOUNT,
      keywords: [],
      signals: { links: [], senderEmail: "priya@brightline.io" },
      logger,
      now: NOW,
    });

    expect(candidates.map((c) => [c.id, c.snippet, c.url]).sort()).toEqual([
      [
        "hubspot:501",
        "Head of Procurement · Brightline · opportunity",
        "https://app.hubspot.com/contacts/48211/record/0-1/501",
      ],
      [
        "salesforce:00QB",
        "Brightline · Lead: Working",
        "https://brightline.my.salesforce.com/lightning/r/Lead/00QB/view",
      ],
    ]);
  });

  it("refuses arguments the account lookups don't document", async () => {
    await expect(
      executor("hubspot")("HUBSPOT_GET_ACCOUNT_INFO", { portal: "1" }),
    ).rejects.toThrow("unknown argument portal");
    await expect(
      executor("salesforce")("SALESFORCE_GET_USER_INFO", {
        include_permissions: "yes",
      }),
    ).rejects.toThrow("include_permissions must be a boolean");
  });

  it("refuses arguments a tool doesn't document", async () => {
    await expect(
      executor("googledrive")("GOOGLEDRIVE_GET_FILE_METADATA", {
        file_id: "cue-demo-enterprise-pricing-v3",
      }),
    ).rejects.toThrow("unknown argument file_id");
    await expect(
      executor("hubspot")("HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA", {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "email",
                operator: "CONTAINS_TOKEN",
                value: "priya",
              },
            ],
          },
        ],
      }),
    ).rejects.toThrow("operator EQ");
    await expect(
      executor("salesforce")("SALESFORCE_SEARCH_LEADS", { limit: 5 }),
    ).rejects.toThrow("at least one search criterion");
  });
});

describe("Composio emulator file uploads", () => {
  it("saves an uploaded attachment to Drive, where search then finds it", async () => {
    const file = await uploadComposioFile({
      app: "googledrive",
      tool: "GOOGLEDRIVE_UPLOAD_FILE",
      filename: "Milestone 2 rubric.pdf",
      mimetype: "application/pdf",
      content: Buffer.from("%PDF-1.4"),
    });
    const saved = await executor("googledrive")("GOOGLEDRIVE_UPLOAD_FILE", {
      file_to_upload: file,
    });

    expect(saved).toMatchObject({
      name: "Milestone 2 rubric.pdf",
      webViewLink: expect.stringContaining("drive.google.com"),
    });
    const found = await searchGoogleDrive(
      executor("googledrive"),
      search(["rubric"]),
    );
    expect(found.map((item) => item.title)).toContain("Milestone 2 rubric.pdf");
  });
});

describe("Composio emulator connection health", () => {
  const canvasKey = { full: "https://canvas.ucsd.edu", generic_api_key: "k" };

  it("keeps no half-made Canvas account when the key check errors", async () => {
    const user = "key-check-errors";
    // The first listing gives the user the emulator's default connection.
    await expect(
      composioProvider.getConnectionStatus({
        app: "canvas",
        authScheme: "API_KEY",
        emailAccountId: user,
      }),
    ).resolves.toBe("active");
    emulator.failTool("CANVAS_LIST_COURSES", "server_error");

    try {
      await expect(
        composioProvider.connectWithCredentials({
          app: "canvas",
          authScheme: "API_KEY",
          emailAccountId: user,
          credentials: canvasKey,
          verifyTool: "CANVAS_LIST_COURSES",
        }),
      ).rejects.toThrow();
    } finally {
      emulator.failTool("CANVAS_LIST_COURSES", null);
    }

    expect(emulator.connectedAccounts(user)).toHaveLength(1);
  });

  it("runs tools on the user's newest active connection", async () => {
    const user = "two-connections";
    await composioProvider.getConnectionStatus({
      app: "canvas",
      authScheme: "API_KEY",
      emailAccountId: user,
    });
    const [older] = emulator.connectedAccounts(user);
    // A second connection, e.g. a reconnect whose cleanup hasn't run yet.
    await fetch(`${emulator.url}/connected_accounts`, {
      method: "POST",
      headers: {
        "x-api-key": emulator.apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        auth_config: { id: older.auth_config_id },
        connection: { user_id: user },
      }),
    });
    const newer = emulator.connectedAccounts(user)[1];

    await composioProvider.executeTool({
      app: "canvas",
      authScheme: "API_KEY",
      emailAccountId: user,
      tool: "CANVAS_GET_CURRENT_USER",
      args: {},
    });

    expect(emulator.toolCalls.at(-1)?.connectedAccountId).toBe(newer.id);
  });

  it("asks the user to reconnect once Composio marks the connection expired", async () => {
    const user = "expired-drive";
    await composioProvider.getConnectionStatus({
      app: "googledrive",
      emailAccountId: user,
    });
    emulator.expireConnections(user);

    await expect(
      composioProvider.getConnectionStatus({
        app: "googledrive",
        emailAccountId: user,
      }),
    ).resolves.toBe("needs_reconnect");
    await expect(
      composioProvider.executeTool({
        app: "googledrive",
        emailAccountId: user,
        tool: "GOOGLEDRIVE_FIND_FILE",
        args: { q: "name contains 'x'" },
      }),
    ).rejects.toBeInstanceOf(ConnectionExpiredError);
  });

  it("asks the user to reconnect when the app revoked the token", async () => {
    emulator.failTool("GOOGLEDRIVE_UPLOAD_FILE", "revoked");
    try {
      await expect(
        composioProvider.executeTool({
          app: "googledrive",
          emailAccountId: "revoked-drive",
          tool: "GOOGLEDRIVE_UPLOAD_FILE",
          args: {},
        }),
      ).rejects.toBeInstanceOf(ConnectionExpiredError);
    } finally {
      emulator.failTool("GOOGLEDRIVE_UPLOAD_FILE", null);
    }
  });
});
