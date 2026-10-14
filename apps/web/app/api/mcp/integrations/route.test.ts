import { NextRequest } from "next/server";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  type ComposioEmulator,
  createComposioEmulator,
} from "@/__tests__/emulators/composio";
import prisma from "@/utils/__mocks__/prisma";
import { createScopedLogger } from "@/utils/logger";

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
vi.mock("@/utils/middleware", () => ({
  withEmailAccount:
    (
      _name: string,
      handler: (
        request: NextRequest & Record<string, unknown>,
      ) => Promise<Response>,
    ) =>
    (request: NextRequest) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "school", userId: "user-1" },
          logger: createScopedLogger("test"),
        }),
      ),
}));

import { GET } from "./route";

let emulator: ComposioEmulator;

beforeAll(async () => {
  emulator = await createComposioEmulator();
  env.COMPOSIO_API_KEY = emulator.apiKey;
  env.COMPOSIO_API_URL = emulator.url;
});

afterAll(async () => {
  await emulator.close();
});

describe("GET /api/mcp/integrations", () => {
  it("flags a connection whose app authorization lapsed at the provider", async () => {
    prisma.mcpConnection.findMany.mockResolvedValue([
      connectionRow("drive-connection", "googledrive", "personal"),
      connectionRow("slack-connection", "slack", "school"),
    ] as never);
    prisma.mcpIntegration.findMany.mockResolvedValue([]);
    // Both start out connected; then Drive's token can't be refreshed.
    await GET(new NextRequest("http://localhost/api/mcp/integrations"));
    emulator.expireConnections("personal");

    const response = await GET(
      new NextRequest("http://localhost/api/mcp/integrations"),
    );
    const body = await response.json();

    const status = Object.fromEntries(
      body.integrations
        .filter(
          (integration: { connection?: unknown }) => integration.connection,
        )
        .map(
          (integration: {
            name: string;
            connection: { needsReconnect: boolean };
          }) => [integration.name, integration.connection.needsReconnect],
        ),
    );
    expect(status).toEqual({ googledrive: true, slack: false });
  });
});

function connectionRow(id: string, name: string, emailAccountId: string) {
  return {
    id,
    name,
    isActive: true,
    emailAccountId,
    emailAccount: { email: `${emailAccountId}@example.com` },
    integration: { id: `${name}-integration`, name },
    tools: [],
  };
}
