import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";
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

    const candidates = await fetchConnectorCandidates({
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

    expect(execute).toHaveBeenCalledWith(
      "GOOGLEDRIVE_FIND_FILE",
      expect.objectContaining({
        q: "(fullText contains 'milestone' or fullText contains 'kevin\\'s') and trashed = false",
      }),
    );
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
  it("lists assignments due around now, with course and due date", async () => {
    const execute = vi.fn(async (tool: string) =>
      tool === "CANVAS_GET_CURRENT_USER"
        ? { response_data: { id: 42 } }
        : {
            response_data: [
              {
                id: "assignment_7",
                title: "Milestone 2",
                context_name: "CSE 151B",
                html_url: "https://canvas.ucsd.edu/courses/1/assignments/7",
                assignment: {
                  due_at: "2026-10-17T06:59:00Z",
                  description: "<p>Model evaluation and <b>write-up</b>.</p>",
                },
              },
            ],
          },
    );

    const items = await searchCanvas(execute, SEARCH);

    expect(execute).toHaveBeenCalledWith(
      "CANVAS_LIST_CALENDAR_EVENTS_FOR_USER",
      expect.objectContaining({
        user_id: 42,
        type: "assignment",
        start_date: "2026-10-06",
        end_date: "2026-11-12",
      }),
    );
    expect(items[0]).toMatchObject({
      kind: "assignment",
      source: "CSE 151B",
      title: "Milestone 2",
      at: "2026-10-17T06:59:00Z",
      snippet: "Model evaluation and write-up.",
    });
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
});
