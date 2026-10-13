import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { buildCueDemoConnectorData } from "@/__tests__/fixtures/inboxes/cue-demo-inbox";
import { composioProvider } from "@/utils/mcp/providers/composio";
import {
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
  redis: { get: vi.fn(async () => null), set: vi.fn(async () => "OK") },
}));

// A Tuesday; the coming Friday is Oct 16.
const NOW = new Date("2026-10-13T16:00:00Z");
const ACCOUNT = "demo-account";

let emulator: ComposioEmulator;

beforeAll(async () => {
  emulator = await createComposioEmulator(buildCueDemoConnectorData(NOW));
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

  it("answers OneDrive and Slack searches with no results", async () => {
    await expect(
      searchOneDrive(executor("one_drive"), search(["pricing"])),
    ).resolves.toEqual([]);
    await expect(
      searchSlack(executor("slack"), search(["pricing"])),
    ).resolves.toEqual([]);
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
