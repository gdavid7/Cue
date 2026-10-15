import { NextRequest } from "next/server";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  type ComposioEmulator,
  createComposioEmulator,
} from "@/__tests__/emulators/composio";
import prisma from "@/utils/__mocks__/prisma";

const env = vi.hoisted(() => ({
  AUTH_SECRET: "test-auth-secret",
  NEXT_PUBLIC_BASE_URL: "http://localhost:3000",
  COMPOSIO_API_KEY: "",
  COMPOSIO_API_URL: "",
}));
const { mockAuth, mockSyncMcpTools, redisStore } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockSyncMcpTools: vi.fn(),
  redisStore: new Map<string, unknown>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({ env }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/utils/mcp/sync-tools", () => ({ syncMcpTools: mockSyncMcpTools }));
vi.mock("@/utils/redis", () => ({
  redis: {
    get: vi.fn(async (key: string) => redisStore.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      redisStore.set(key, value);
      return "OK";
    }),
    del: vi.fn(async (...keys: string[]) => {
      for (const key of keys) redisStore.delete(key);
      return keys.length;
    }),
    getdel: vi.fn(async (key: string) => {
      const value = redisStore.get(key) ?? null;
      redisStore.delete(key);
      return value;
    }),
  },
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithErrorTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithErrorTestMiddleware();
});

import { composioProvider } from "@/utils/mcp/providers/composio";
import {
  generateSignedOAuthState,
  getMcpStateCookieName,
} from "@/utils/oauth/state";
import { GET } from "./route";

const INTEGRATION = "hubspot";
const CALLBACK_URL = `http://localhost:3000/api/mcp/${INTEGRATION}/provider-callback`;
const params = { params: Promise.resolve({ integration: INTEGRATION }) };

let emulator: ComposioEmulator;

beforeAll(async () => {
  emulator = await createComposioEmulator();
  env.COMPOSIO_API_KEY = emulator.apiKey;
  env.COMPOSIO_API_URL = emulator.url;
});

afterAll(async () => {
  await emulator.close();
});

describe("provider callback with Composio", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    redisStore.clear();
    prisma.emailAccount.findFirst.mockImplementation((async (args: {
      where: { id: string; userId: string };
    }) =>
      args.where.userId === ownerOf(args.where.id)
        ? { id: args.where.id }
        : null) as never);
    prisma.mcpIntegration.upsert.mockResolvedValue({
      id: "integration-1",
    } as never);
    mockSyncMcpTools.mockResolvedValue({ toolsCount: 3 });
  });

  it("connects the account the user authorized through their own link", async () => {
    const redirectUrl = await startConnect("owner-account");
    const callbackUrl = emulator.authorizeLink(redirectUrl);
    mockAuth.mockResolvedValue({ user: { id: "owner" } });

    const response = await GET(
      callbackRequest(callbackUrl, stateFor("owner", "owner-account")),
      params,
    );

    expect(response.headers.get("location")).toContain("connected=hubspot");
    const accounts = emulator
      .connectedAccounts("owner-account")
      .map((account) => account.id);
    expect(accounts).toEqual([connectedAccountIdOf(callbackUrl)]);
  });

  it("does not hand the attacker an account someone else authorized from their link", async () => {
    const redirectUrl = await startConnect("attacker-account");
    // The victim opens the attacker's link and authorizes their own app
    const victimCallbackUrl = emulator.authorizeLink(redirectUrl);
    const victimAccountId = connectedAccountIdOf(victimCallbackUrl);

    // The victim's browser arrives without the attacker's state cookie
    mockAuth.mockResolvedValue({ user: { id: "victim" } });
    const victimResponse = await GET(
      callbackRequest(victimCallbackUrl),
      params,
    );
    expect(victimResponse.headers.get("location")).toContain(
      "error=invalid_state",
    );

    // The attacker then finishes the flow from their own session
    mockAuth.mockResolvedValue({ user: { id: "attacker" } });
    const attackerResponse = await GET(
      callbackRequest(
        `${CALLBACK_URL}?status=success&connected_account_id=${victimAccountId}`,
        stateFor("attacker", "attacker-account"),
      ),
      params,
    );

    expect(attackerResponse.headers.get("location")).toContain(
      "error=connection_failed",
    );
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
    expect(
      emulator
        .connectedAccounts("attacker-account")
        .map((account) => account.id),
    ).not.toContain(victimAccountId);
  });

  it("discards the attacker's link even when the victim has their own connect in progress", async () => {
    const attackerLink = await startConnect("attacker-account");
    await startConnect("victim-account");
    // The victim opens the attacker's link in the browser holding their own state
    const callbackUrl = emulator.authorizeLink(attackerLink);
    const attackerAccountId = connectedAccountIdOf(callbackUrl);
    mockAuth.mockResolvedValue({ user: { id: "victim" } });

    const response = await GET(
      callbackRequest(callbackUrl, stateFor("victim", "victim-account")),
      params,
    );

    expect(response.headers.get("location")).toContain(
      "error=connection_failed",
    );
    expect(
      emulator
        .connectedAccounts("attacker-account")
        .map((account) => account.id),
    ).not.toContain(attackerAccountId);
  });

  it("does not adopt an active account the user did not start a link for", async () => {
    // An account already ACTIVE under the user id, e.g. one the attacker had
    // a victim authorize earlier, with no connect started in this session
    await composioProvider.getConnectionStatus({
      app: INTEGRATION,
      emailAccountId: "attacker-account",
    });
    mockAuth.mockResolvedValue({ user: { id: "attacker" } });

    const response = await GET(
      callbackRequest(
        `${CALLBACK_URL}?status=success`,
        stateFor("attacker", "attacker-account"),
      ),
      params,
    );

    expect(response.headers.get("location")).toContain(
      "error=connection_failed",
    );
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
  });

  it("rejects a callback whose session is not the user who started it", async () => {
    const redirectUrl = await startConnect("owner-account");
    const callbackUrl = emulator.authorizeLink(redirectUrl);
    mockAuth.mockResolvedValue({ user: { id: "someone-else" } });

    const response = await GET(
      callbackRequest(callbackUrl, stateFor("owner", "owner-account")),
      params,
    );

    expect(response.headers.get("location")).not.toContain("connected=");
    expect(prisma.mcpConnection.upsert).not.toHaveBeenCalled();
  });
});

function ownerOf(emailAccountId: string) {
  return emailAccountId.replace(/-account$/, "");
}

function startConnect(emailAccountId: string) {
  return composioProvider.getConnectUrl({
    app: INTEGRATION,
    emailAccountId,
    userId: ownerOf(emailAccountId),
    callbackUrl: CALLBACK_URL,
  });
}

function stateFor(userId: string, emailAccountId: string) {
  return generateSignedOAuthState({
    userId,
    emailAccountId,
    type: `${INTEGRATION}-mcp`,
  });
}

function callbackRequest(url: string, state?: string) {
  return new NextRequest(
    url,
    state
      ? {
          headers: {
            cookie: `${getMcpStateCookieName(INTEGRATION)}=${state}`,
          },
        }
      : undefined,
  );
}

function connectedAccountIdOf(callbackUrl: string) {
  return new URL(callbackUrl).searchParams.get("connected_account_id") ?? "";
}
