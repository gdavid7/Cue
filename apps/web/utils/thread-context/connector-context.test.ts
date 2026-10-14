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
