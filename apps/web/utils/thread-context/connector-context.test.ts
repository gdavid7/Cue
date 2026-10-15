import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
import { redis } from "@/utils/redis";
import {
  fetchConnectorCandidates,
  searchCanvas,
  searchGoogleDrive,
  searchOneDrive,
  searchSlack,
} from "./connector-context";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/redis", () => ({
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
}));
const { mockExecuteTool } = vi.hoisted(() => ({ mockExecuteTool: vi.fn() }));
vi.mock("@/utils/mcp/providers/registry", () => ({
  getIntegrationProvider: () => ({ executeTool: mockExecuteTool }),
}));

const NOW = new Date("2026-10-13T16:00:00Z");
const SEARCH = {
  emailAccountId: "account-1",
  keywords: ["milestone", "kevin's"],
  now: NOW,
};

describe("fetchConnectorCandidates", () => {
  const logger = createScopedLogger("connector-context-test");

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("searches an app connected from the person's other account through that account, once", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      { emailAccountId: "personal", integration: { name: "googledrive" } },
      { emailAccountId: "school", integration: { name: "googledrive" } },
      { emailAccountId: "personal", integration: { name: "slack" } },
    ] as never);
    mockExecuteTool.mockImplementation(async ({ app }: { app: string }) =>
      app === "slack"
        ? { messages: { matches: [] } }
        : {
            files: [
              {
                id: "f1",
                name: "Milestone 2",
                modifiedTime: NOW.toISOString(),
              },
            ],
          },
    );

    const { candidates } = await fetchConnectorCandidates({
      emailAccountId: "school",
      keywords: ["milestone"],
      logger,
      now: NOW,
    });

    expect(candidates.map((c) => c.id)).toEqual(["googledrive:f1"]);
    expect(
      mockExecuteTool.mock.calls.map(([args]) => [
        args.app,
        args.emailAccountId,
      ]),
    ).toEqual([
      ["googledrive", "school"],
      ["slack", "personal"],
    ]);
    // Only the person's own accounts; the real query is covered in
    // __tests__/db/user-connections.test.ts
    expect(prisma.mcpConnection.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          emailAccount: {
            user: { emailAccounts: { some: { id: "school" } } },
          },
        }),
      }),
    );
  });
});

describe("searchGoogleDrive", () => {
  it("searches file contents for each word and keeps who owns each file", async () => {
    const execute = vi.fn(async () => ({
      files: [
        {
          id: "f1",
          name: "CSE 151B milestone 2 write-up",
          mimeType: "application/vnd.google-apps.document",
          modifiedTime: "2026-10-12T20:00:00Z",
          webViewLink: "https://docs.google.com/document/d/f1",
          owners: [
            { displayName: "Kevin Ruiz", emailAddress: "kruiz@ucsd.edu" },
          ],
        },
        {
          id: "folder",
          name: "CSE 151B",
          mimeType: "application/vnd.google-apps.folder",
        },
      ],
    }));

    const items = await searchGoogleDrive(execute, SEARCH);

    // Drive rejects orderBy on a fullText query, so none is sent.
    expect(execute).toHaveBeenCalledWith("GOOGLEDRIVE_FIND_FILE", {
      q: "(fullText contains 'milestone' or fullText contains 'kevin\\'s') and trashed = false and mimeType != 'application/vnd.google-apps.folder'",
      fields:
        "files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress))",
      pageSize: 10,
      corpora: "allDrives",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
    expect(items).toEqual([
      expect.objectContaining({
        id: "googledrive:f1",
        kind: "file",
        source: "Google Drive",
        url: "https://docs.google.com/document/d/f1",
        people: [{ email: "kruiz@ucsd.edu", name: "Kevin Ruiz" }],
      }),
    ]);
  });
});

describe("searchOneDrive", () => {
  it("returns files, not folders", async () => {
    const execute = vi.fn(async () => ({
      value: [
        { id: "a", name: "Milestone notes.docx", webUrl: "https://x/a" },
        { id: "b", name: "Course", folder: { childCount: 3 } },
      ],
    }));

    const items = await searchOneDrive(execute, SEARCH);

    expect(items.map((item) => item.title)).toEqual(["Milestone notes.docx"]);
  });
});

describe("searchCanvas", () => {
  function canvas(events: unknown[], courseIds = [1]) {
    return vi.fn(async (tool: string) => {
      if (tool === "CANVAS_GET_CURRENT_USER") {
        return { response_data: { id: 42 } };
      }
      if (tool === "CANVAS_LIST_COURSES") {
        return { response_data: courseIds.map((id) => ({ id, name: "x" })) };
      }
      return { response_data: events };
    });
  }

  const milestone = {
    id: "assignment_7",
    title: "Milestone 2",
    context_name: "CSE 151B",
    html_url: "https://canvas.ucsd.edu/courses/1/assignments/7",
    assignment: {
      due_at: "2026-10-17T06:59:00Z",
      description: "<p>Model evaluation and <b>write-up</b>.</p>",
    },
  };

  it("lists assignments due around now in the student's courses, with course and due date", async () => {
    const execute = canvas([milestone]);

    const items = await searchCanvas(execute, SEARCH);

    expect(execute).toHaveBeenCalledWith("CANVAS_LIST_COURSES", {
      enrollment_state: "active",
    });
    expect(execute).toHaveBeenCalledWith(
      "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
      {
        user_id: 42,
        type: "assignment",
        context_codes: ["course_1"],
        start_date: "2026-10-06",
        end_date: "2026-11-12",
      },
    );
    expect(items[0]).toMatchObject({
      kind: "assignment",
      source: "CSE 151B",
      title: "Milestone 2",
      at: "2026-10-17T06:59:00Z",
      snippet: "Model evaluation and write-up.",
    });
  });

  it("asks for at most 10 courses, newest first", async () => {
    const execute = canvas(
      [],
      Array.from({ length: 12 }, (_, i) => i + 1),
    );

    await searchCanvas(execute, SEARCH);

    expect(execute).toHaveBeenCalledWith(
      "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
      expect.objectContaining({
        context_codes: [12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(
          (id) => `course_${id}`,
        ),
      }),
    );
  });

  it("skips the calendar when the student has no active courses", async () => {
    const execute = canvas([milestone], []);

    await expect(searchCanvas(execute, SEARCH)).resolves.toEqual([]);
    expect(execute).not.toHaveBeenCalledWith(
      "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
      expect.anything(),
    );
  });

  it("keeps the other assignments when one event is malformed", async () => {
    const execute = canvas([{ id: 9, title: null }, milestone]);

    const items = await searchCanvas(execute, SEARCH);

    expect(items.map((item) => item.title)).toEqual(["Milestone 2"]);
  });
});

describe("searchSlack", () => {
  it("turns matches into messages with channel, author and link", async () => {
    const execute = vi.fn(async () => ({
      messages: {
        matches: [
          {
            text: "I'll make the plots for milestone 2",
            ts: "1791900000.000100",
            username: "kevin",
            permalink: "https://slack.com/archives/C1/p1",
            channel: { id: "C1", name: "cse151b" },
          },
        ],
      },
    }));

    const items = await searchSlack(execute, SEARCH);

    expect(items[0]).toMatchObject({
      kind: "chat",
      title: "#cse151b · kevin",
      url: "https://slack.com/archives/C1/p1",
    });
  });

  it("fails instead of reporting no messages when Slack refuses the search", async () => {
    const execute = vi.fn(async () => ({ ok: false, error: "missing_scope" }));

    await expect(searchSlack(execute, SEARCH)).rejects.toThrow("missing_scope");
  });

  it("fails on a response it can't read, naming fields but not content", async () => {
    const execute = vi.fn(async () => ({
      response_data: { messages: { matches: [{ text: "secret plans" }] } },
    }));

    const error = await searchSlack(execute, SEARCH).catch((e) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("messages");
    expect(error.message).not.toContain("secret plans");
  });
});

describe("fetchConnectorCandidates with an unreadable app", () => {
  it("leaves the app out and logs it at warn without the content", async () => {
    const logger = createScopedLogger("connector-context-test");
    const warn = vi.spyOn(logger, "warn");
    prisma.mcpConnection.findMany.mockResolvedValue([
      { emailAccountId: "school", integration: { name: "slack" } },
    ] as never);
    mockExecuteTool.mockResolvedValue({
      response_data: { secret: "salary numbers" },
    });

    const result = await fetchConnectorCandidates({
      emailAccountId: "school",
      keywords: ["milestone"],
      logger,
      now: NOW,
    });

    expect(result).toEqual({ candidates: [], complete: false });
    expect(warn).toHaveBeenCalledWith("Connected app search failed", {
      app: "slack",
      error: expect.any(Error),
    });
    const [, fields] = warn.mock.calls[0] as [string, { error: Error }];
    expect(fields.error.message).not.toContain("salary");
  });
});

describe("fetchConnectorCandidates with links and the sender in the thread", () => {
  const logger = createScopedLogger("connector-context-test");

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  function connected(...apps: string[]) {
    prisma.mcpConnection.findMany.mockResolvedValue(
      apps.map((name) => ({
        emailAccountId: "school",
        integration: { name },
      })) as never,
    );
  }

  function answer(byTool: Record<string, (args: never) => unknown>) {
    mockExecuteTool.mockImplementation(
      async ({ tool, args }: { tool: string; args: never }) => {
        const handler = byTool[tool];
        if (!handler) throw new Error(`unexpected ${tool}`);
        return handler(args);
      },
    );
  }

  function calls() {
    return mockExecuteTool.mock.calls.map(([call]) => [call.tool, call.args]);
  }

  function lookup(signals: { links?: string[]; senderEmail?: string }) {
    return fetchConnectorCandidates({
      emailAccountId: "school",
      keywords: [],
      signals: { links: [], ...signals },
      logger,
      now: NOW,
    });
  }

  it("turns Google Drive links into file cards, once per file, leaving folders and other sites alone", async () => {
    connected("googledrive");
    answer({
      GOOGLEDRIVE_GET_FILE_METADATA: (args: { fileId: string }) => ({
        id: args.fileId,
        name: "CSE 151B milestone 2 write-up",
        mimeType: "application/vnd.google-apps.document",
        modifiedTime: "2026-10-12T20:00:00Z",
        webViewLink: `https://docs.google.com/document/d/${args.fileId}/edit`,
        owners: [{ displayName: "Kevin Ruiz", emailAddress: "kruiz@ucsd.edu" }],
      }),
    });

    const { candidates, complete } = await lookup({
      links: [
        "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit?usp=sharing",
        "https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/view",
        "https://drive.google.com/drive/folders/1FolderFolderFolderFolder0000",
        "https://example.com/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      ],
    });

    expect(calls()).toEqual([
      [
        "GOOGLEDRIVE_GET_FILE_METADATA",
        {
          fileId: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
          fields:
            "id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress)",
          supportsAllDrives: true,
        },
      ],
    ]);
    expect(complete).toBe(true);
    expect(candidates).toEqual([
      {
        id: "googledrive:1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        kind: "file",
        source: "Google Drive",
        title: "CSE 151B milestone 2 write-up",
        text: "CSE 151B milestone 2 write-up\nGoogle Doc · Kevin Ruiz",
        snippet: "Google Doc · Kevin Ruiz",
        at: "2026-10-12T20:00:00.000Z",
        url: "https://docs.google.com/document/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
        people: [{ email: "kruiz@ucsd.edu", name: "Kevin Ruiz" }],
        linkedBy: "url",
      },
    ]);
  });

  it("keeps one card for a file both linked and found by search, marked as linked", async () => {
    connected("googledrive");
    const file = {
      id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
      name: "Milestone 2",
      modifiedTime: NOW.toISOString(),
    };
    answer({
      GOOGLEDRIVE_FIND_FILE: () => ({ files: [file] }),
      GOOGLEDRIVE_GET_FILE_METADATA: () => file,
    });

    const { candidates } = await fetchConnectorCandidates({
      emailAccountId: "school",
      keywords: ["milestone"],
      signals: {
        links: [`https://docs.google.com/document/d/${file.id}/edit`],
      },
      logger,
      now: NOW,
    });

    expect(candidates).toEqual([
      expect.objectContaining({
        id: `googledrive:${file.id}`,
        linkedBy: "url",
      }),
    ]);
  });

  it("turns Jira browse links into issue cards", async () => {
    connected("jira");
    answer({
      JIRA_GET_ISSUE: () => ({
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
      }),
    });

    const { candidates } = await lookup({
      links: [
        "https://acme.atlassian.net/browse/OPS-12?focusedCommentId=1",
        "https://acme.atlassian.net/jira/software/projects/OPS/boards/1",
      ],
    });

    expect(calls()).toEqual([
      [
        "JIRA_GET_ISSUE",
        {
          issue_id_or_key: "OPS-12",
          fields: ["summary", "status", "assignee", "priority", "updated"],
        },
      ],
    ]);
    expect(candidates).toEqual([
      {
        id: "jira:OPS-12",
        kind: "task",
        source: "Jira",
        title: "OPS-12 Rotate staging keys",
        text: "OPS-12 Rotate staging keys\nIn Progress · Nora Patel · High",
        snippet: "In Progress · Nora Patel · High",
        at: "2026-10-12T09:00:00.000Z",
        url: "https://acme.atlassian.net/browse/OPS-12",
        people: [{ email: "nora@acme.com", name: "Nora Patel" }],
        linkedBy: "url",
      },
    ]);
  });

  it("shows no Jira card when the connected site is not the one linked", async () => {
    connected("jira");
    answer({
      JIRA_GET_ISSUE: () => ({
        key: "OPS-12",
        self: "https://other.atlassian.net/rest/api/3/issue/10012",
        fields: { summary: "Someone else's issue", status: { name: "Done" } },
      }),
    });

    const { candidates } = await lookup({
      links: ["https://acme.atlassian.net/browse/OPS-12"],
    });

    expect(candidates).toEqual([]);
  });

  describe("with an OAuth connection, which answers through api.atlassian.com", () => {
    const CLOUD_ID = "11111111-2222-3333-4444-555555555555";

    function oauthIssue() {
      answer({
        JIRA_GET_ISSUE: () => ({
          key: "OPS-12",
          self: `https://api.atlassian.com/ex/jira/${CLOUD_ID}/rest/api/3/issue/10012`,
          fields: { summary: "Rotate staging keys", status: { name: "Done" } },
        }),
      });
    }

    function tenantInfo(respond: (url: string) => Promise<Response>) {
      return vi
        .spyOn(globalThis, "fetch")
        .mockImplementation(async (input) => respond(String(input)));
    }

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("shows the issue when the linked site is the connected one", async () => {
      connected("jira");
      oauthIssue();
      const fetch = tenantInfo(async () =>
        Response.json({ cloudId: CLOUD_ID }),
      );

      const { candidates } = await lookup({
        links: ["https://acme.atlassian.net/browse/OPS-12"],
      });

      expect(fetch).toHaveBeenCalledWith(
        "https://acme.atlassian.net/_edge/tenant_info",
        expect.objectContaining({ redirect: "error" }),
      );
      expect(candidates).toEqual([
        expect.objectContaining({
          id: "jira:OPS-12",
          url: "https://acme.atlassian.net/browse/OPS-12",
        }),
      ]);
    });

    it("shows nothing when the linked site is another tenant", async () => {
      connected("jira");
      oauthIssue();
      tenantInfo(async () =>
        Response.json({ cloudId: "99999999-0000-0000-0000-000000000000" }),
      );

      const { candidates } = await lookup({
        links: ["https://evil.atlassian.net/browse/OPS-12"],
      });

      expect(candidates).toEqual([]);
    });

    it("shows nothing when the linked site can't be identified", async () => {
      connected("jira");
      oauthIssue();
      tenantInfo(async () => new Response("Not found", { status: 404 }));

      const { candidates } = await lookup({
        links: ["https://acme.atlassian.net/browse/OPS-12"],
      });

      expect(candidates).toEqual([]);
    });

    it("never asks a host that isn't a plain Atlassian site", async () => {
      connected("jira");
      oauthIssue();
      const fetch = tenantInfo(async () =>
        Response.json({ cloudId: CLOUD_ID }),
      );

      const { candidates } = await lookup({
        links: [
          "https://acme.atlassian.net.evil.com/browse/OPS-12",
          "https://a.b.atlassian.net/browse/OPS-12",
          "http://acme.atlassian.net:8080/browse/OPS-12",
        ],
      });

      expect(fetch).not.toHaveBeenCalled();
      expect(mockExecuteTool).not.toHaveBeenCalled();
      expect(candidates).toEqual([]);
    });
  });

  it("turns Asana task links, old and new style, into task cards", async () => {
    connected("asana");
    answer({
      ASANA_GET_A_TASK: (args: { task_gid: string }) => ({
        data: {
          gid: args.task_gid,
          name: `Task ${args.task_gid}`,
          completed: args.task_gid === "1200000000000002",
          due_on: "2026-10-16",
          assignee: { name: "Kevin Ruiz" },
          permalink_url: `https://app.asana.com/0/0/${args.task_gid}`,
          modified_at: "2026-10-12T10:00:00.000Z",
        },
      }),
    });

    const { candidates } = await lookup({
      links: [
        "https://app.asana.com/0/1199999999999999/1200000000000001/f",
        "https://app.asana.com/1/1100000000000000/project/1199999999999999/task/1200000000000002",
        "https://app.asana.com/0/1199999999999999/list",
      ],
    });

    expect(calls()).toEqual(
      ["1200000000000001", "1200000000000002"].map((gid) => [
        "ASANA_GET_A_TASK",
        {
          task_gid: gid,
          opt_fields: [
            "name",
            "completed",
            "due_on",
            "assignee.name",
            "permalink_url",
            "modified_at",
          ],
        },
      ]),
    );
    expect(candidates.map((c) => [c.id, c.kind, c.source, c.snippet])).toEqual([
      [
        "asana:1200000000000001",
        "task",
        "Asana",
        "Due 2026-10-16 · Kevin Ruiz",
      ],
      ["asana:1200000000000002", "task", "Asana", "Completed · Kevin Ruiz"],
    ]);
  });

  it("turns ClickUp task links into task cards", async () => {
    connected("clickup");
    answer({
      CLICKUP_GET_TASK: () => ({
        id: "86abc123",
        name: "Slides for the group project",
        status: { status: "in progress" },
        assignees: [{ username: "Kevin Ruiz", email: "kruiz@ucsd.edu" }],
        date_updated: String(Date.parse("2026-10-12T10:00:00Z")),
        url: "https://app.clickup.com/t/86abc123",
      }),
    });

    const { candidates } = await lookup({
      links: [
        "https://app.clickup.com/t/86abc123",
        "https://app.clickup.com/t/9011111/DEV-12",
      ],
    });

    expect(calls()).toEqual([["CLICKUP_GET_TASK", { task_id: "86abc123" }]]);
    expect(candidates).toEqual([
      {
        id: "clickup:86abc123",
        kind: "task",
        source: "ClickUp",
        title: "Slides for the group project",
        text: "Slides for the group project\nin progress · Kevin Ruiz",
        snippet: "in progress · Kevin Ruiz",
        at: "2026-10-12T10:00:00.000Z",
        url: "https://app.clickup.com/t/86abc123",
        people: [{ email: "kruiz@ucsd.edu", name: "Kevin Ruiz" }],
        linkedBy: "url",
      },
    ]);
  });

  it("looks the sender up in HubSpot by exact email", async () => {
    connected("hubspot");
    answer({
      HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: () => ({
        results: [
          {
            id: "501",
            properties: {
              email: "Nora@Northwind.com",
              firstname: "Nora",
              lastname: "Patel",
              jobtitle: "VP Finance",
              company: "Northwind",
              lifecyclestage: "customer",
              lastmodifieddate: "2026-09-01T00:00:00Z",
            },
          },
        ],
      }),
      HUBSPOT_GET_ACCOUNT_INFO: () => ({
        hub_id: 4211,
        hub_domain: "northwind-sales.com",
      }),
    });

    const { candidates } = await lookup({ senderEmail: "nora@northwind.com" });

    expect(calls()).toHaveLength(2);
    expect(calls()).toContainEqual(["HUBSPOT_GET_ACCOUNT_INFO", {}]);
    expect(redis.set).toHaveBeenCalledWith(
      "hubspot-portal-id:school",
      "4211",
      expect.anything(),
    );
    expect(calls()).toContainEqual([
      "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
      {
        filterGroups: [
          {
            filters: [
              {
                propertyName: "email",
                operator: "EQ",
                value: "nora@northwind.com",
              },
            ],
          },
        ],
        properties: [
          "email",
          "firstname",
          "lastname",
          "jobtitle",
          "company",
          "lifecyclestage",
          "lastmodifieddate",
        ],
        limit: 1,
      },
    ]);
    expect(candidates).toEqual([
      {
        id: "hubspot:501",
        kind: "contact",
        source: "HubSpot",
        title: "Nora Patel",
        text: "Nora Patel\nVP Finance · Northwind · customer",
        snippet: "VP Finance · Northwind · customer",
        at: "2026-09-01T00:00:00.000Z",
        url: "https://app.hubspot.com/contacts/4211/record/0-1/501",
        people: [{ email: "nora@northwind.com", name: "Nora Patel" }],
        linkedBy: "sender",
      },
    ]);
  });

  it("links a HubSpot contact through the connection's cached portal without asking again", async () => {
    connected("hubspot");
    vi.mocked(redis.get).mockImplementation(async (key: string) =>
      key === "hubspot-portal-id:school" ? "4211" : null,
    );
    answer({
      HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: () => ({
        results: [{ id: "501", properties: { email: "nora@northwind.com" } }],
      }),
    });

    const { candidates } = await lookup({ senderEmail: "nora@northwind.com" });

    expect(calls().map(([tool]) => tool)).toEqual([
      "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA",
    ]);
    expect(candidates[0]?.url).toBe(
      "https://app.hubspot.com/contacts/4211/record/0-1/501",
    );
    vi.mocked(redis.get).mockImplementation(async () => null);
  });

  it("finds the sender among Salesforce contacts, then leads, ignoring partial matches", async () => {
    connected("salesforce");
    answer({
      SALESFORCE_SEARCH_CONTACTS: () => ({
        totalSize: 1,
        records: [{ Id: "003A", Name: "Nora P", Email: "nora@northwind.co" }],
      }),
      SALESFORCE_SEARCH_LEADS: () => ({
        totalSize: 1,
        records: [
          {
            Id: "00QB",
            Name: "Nora Patel",
            Email: "nora@northwind.com",
            Title: "VP Finance",
            Company: "Northwind",
            Status: "Working",
            LastModifiedDate: "2026-09-01T00:00:00.000+0000",
          },
        ],
      }),
      SALESFORCE_GET_USER_INFO: () => ({
        salesforce_user_details: {
          user_id: "005A",
          profile: "https://acme.my.salesforce.com/005A",
          urls: {
            rest: "https://acme.my.salesforce.com/services/data/v{version}/",
          },
        },
      }),
    });

    const { candidates } = await lookup({ senderEmail: "nora@northwind.com" });

    expect(
      calls().filter(([tool]) => tool !== "SALESFORCE_GET_USER_INFO"),
    ).toEqual([
      ["SALESFORCE_SEARCH_CONTACTS", { email: "nora@northwind.com", limit: 5 }],
      ["SALESFORCE_SEARCH_LEADS", { email: "nora@northwind.com", limit: 5 }],
    ]);
    expect(calls()).toContainEqual(["SALESFORCE_GET_USER_INFO", {}]);
    expect(candidates).toEqual([
      {
        id: "salesforce:00QB",
        kind: "contact",
        source: "Salesforce",
        title: "Nora Patel",
        text: "Nora Patel\nVP Finance · Northwind · Lead: Working",
        snippet: "VP Finance · Northwind · Lead: Working",
        at: "2026-09-01T00:00:00.000Z",
        url: "https://acme.my.salesforce.com/lightning/r/Lead/00QB/view",
        people: [{ email: "nora@northwind.com", name: "Nora Patel" }],
        linkedBy: "sender",
      },
    ]);
  });

  it("links nowhere when Salesforce names an address outside its own domains", async () => {
    connected("salesforce");
    answer({
      SALESFORCE_SEARCH_CONTACTS: () => ({
        totalSize: 1,
        records: [{ Id: "003A", Name: "Nora", Email: "nora@northwind.com" }],
      }),
      SALESFORCE_GET_USER_INFO: () => ({
        profile: "https://acme.my.salesforce.com.evil.example/005A",
      }),
    });

    const { candidates } = await lookup({ senderEmail: "nora@northwind.com" });

    expect(candidates).toEqual([
      expect.objectContaining({ id: "salesforce:003A", url: undefined }),
    ]);
  });

  // GET_USER_INFO isn't answered here, so finding the instance fails.
  it("uses a Salesforce contact without asking for leads, unlinked when the instance can't be found", async () => {
    connected("salesforce");
    answer({
      SALESFORCE_SEARCH_CONTACTS: () => ({
        totalSize: 1,
        records: [
          {
            Id: "003A",
            Name: "Nora Patel",
            Email: "nora@northwind.com",
            Title: "VP Finance",
            Account: { Name: "Northwind" },
          },
        ],
      }),
    });

    const { candidates } = await lookup({ senderEmail: "nora@northwind.com" });

    expect(calls().map(([tool]) => tool)).not.toContain(
      "SALESFORCE_SEARCH_LEADS",
    );
    expect(candidates[0]).toMatchObject({
      id: "salesforce:003A",
      snippet: "VP Finance · Northwind",
      at: NOW.toISOString(),
    });
    expect(candidates[0]?.url).toBeUndefined();
  });

  it("asks nothing of the apps when the thread has no links or sender", async () => {
    connected("googledrive", "hubspot");

    await expect(lookup({})).resolves.toEqual({
      candidates: [],
      complete: true,
    });
    expect(prisma.mcpConnection.findMany).not.toHaveBeenCalled();
  });

  it("shows no card for a failed or slow lookup, keeps the rest, and logs no content", async () => {
    vi.useFakeTimers();
    connected("hubspot", "jira", "googledrive");
    const warn = vi.spyOn(logger, "warn");
    answer({
      HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA: () => {
        throw new Error(
          "HUBSPOT_SEARCH_CONTACTS_BY_CRITERIA failed: bad filter nora@northwind.com",
        );
      },
      JIRA_GET_ISSUE: () => new Promise(() => {}),
      GOOGLEDRIVE_GET_FILE_METADATA: () => ({
        id: "1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
        name: "Pricing",
      }),
    });

    const pending = lookup({
      senderEmail: "nora@northwind.com",
      links: [
        "https://acme.atlassian.net/browse/OPS-12",
        "https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz012345/edit",
      ],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const result = await pending;

    expect(result.candidates.map((c) => c.id)).toEqual([
      "googledrive:1AbCdEfGhIjKlMnOpQrStUvWxYz012345",
    ]);
    // A link that can never be read must not keep the thread from caching.
    expect(result.complete).toBe(true);
    expect(warn.mock.calls).toEqual(
      expect.arrayContaining([
        ["Connected app lookup failed", { app: "hubspot", reason: "error" }],
        ["Connected app lookup failed", { app: "jira", reason: "timeout" }],
      ]),
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain("nora@");
  });
});
