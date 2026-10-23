import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createBackendMailboxSource } from "@inboxzero/mail-core/protocol/backend-adapter";
import {
  MAIL_ENGINE_REVISION,
  MAIL_ENGINE_REVISION_HEADER,
} from "@inboxzero/mail-core/protocol/mail-http";
import { createScopedLogger } from "@/utils/logger";
import { POST } from "./route";

vi.mock("server-only", () => ({}));

const getMessagesWithPagination = vi.fn();
const enumerated = vi.hoisted(() => ({
  page: null as null | Record<string, unknown>,
  oldEngine: undefined as unknown,
}));

// Lets a case stand in for the source's page, such as one a Gmail sync
// budget paces, while the rest go through the real Microsoft source.
vi.mock("@/utils/mail-api/source", async (original) => {
  const actual = await original<typeof import("@/utils/mail-api/source")>();
  return {
    ...actual,
    createEmailProviderMailboxSource: (
      input: Parameters<typeof actual.createEmailProviderMailboxSource>[0],
    ) => {
      const source = actual.createEmailProviderMailboxSource(input);
      enumerated.oldEngine = input.oldEngine;
      return {
        ...source,
        enumerate: (request: Parameters<typeof source.enumerate>[0]) =>
          enumerated.page
            ? Promise.resolve({ status: "ok", value: enumerated.page })
            : source.enumerate(request),
      };
    },
  };
});

vi.mock("@/utils/middleware", () => ({
  withEmailProvider:
    (
      _name: string,
      handler: (
        request: NextRequest & Record<string, unknown>,
        context: { params: Promise<{ accountId: string }> },
      ) => Promise<Response>,
    ) =>
    (
      request: NextRequest,
      context: { params: Promise<{ accountId: string }> },
    ) =>
      handler(
        Object.assign(request, {
          auth: { emailAccountId: "acc-1", userId: "user-1" },
          emailProvider: {
            name: "microsoft",
            localMailSyncStrategy: "folder-delta",
            getMessagesWithPagination,
          },
          logger: createScopedLogger("test"),
        }),
        context,
      ),
}));

describe("POST /enumeration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    enumerated.page = null;
    enumerated.oldEngine = undefined;
  });

  describe("engine revision", () => {
    const browser = "Mozilla/5.0 (Macintosh) Chrome/140.0 Safari/537.36";

    it.each([
      [
        "a browser engine that sends no revision",
        { "user-agent": browser },
        "missing_revision",
      ],
      [
        "an engine below the minimum",
        { "user-agent": browser, [MAIL_ENGINE_REVISION_HEADER]: "0" },
        "below_minimum",
      ],
      [
        "a current browser engine",
        {
          "user-agent": browser,
          [MAIL_ENGINE_REVISION_HEADER]: String(MAIL_ENGINE_REVISION),
        },
        null,
      ],
      // Desktop builds from before the header pace themselves and update on
      // their own, so their sync is left alone.
      [
        "a desktop engine that sends no revision",
        { "user-agent": "node" },
        null,
      ],
    ])("tells the source about %s", async (_name, headers, expected) => {
      enumerated.page = pagedResult();
      await routeBackedSource(headers).enumerate(enumerationInput());
      expect(enumerated.oldEngine).toBe(expected);
    });
  });

  it("carries the budget's wait for the next page to the client", async () => {
    enumerated.page = { ...pagedResult(), retryAfterMs: 6000 };
    const result = await routeBackedSource().enumerate(enumerationInput());
    expect(result).toMatchObject({
      status: "ok",
      value: { nextPage: "next", retryAfterMs: 6000 },
    });
  });

  it("leaves the wait out when the next page may go at once", async () => {
    enumerated.page = pagedResult();
    const result = await routeBackedSource().enumerate(enumerationInput());
    expect(result).toMatchObject({ status: "ok", value: { nextPage: "next" } });
    expect(result.status === "ok" && "retryAfterMs" in result.value).toBe(
      false,
    );
  });

  it("returns an adapter-readable throttled envelope for source pauses", async () => {
    getMessagesWithPagination.mockRejectedValue(
      Object.assign(new Error("rate limited"), {
        name: "ProviderRateLimitModeError",
        provider: "microsoft",
      }),
    );
    const result = await routeBackedSource().enumerate(enumerationInput());
    expect(result).toEqual({
      status: "paused",
      reason: "throttled",
      retryAfterMs: 15_000,
    });
  });

  it("returns an adapter-readable blocked auth envelope for auth failures", async () => {
    getMessagesWithPagination.mockRejectedValue(new Error("401 unauthorized"));
    const result = await routeBackedSource().enumerate(enumerationInput());
    expect(result).toEqual({ status: "blocked_auth" });
  });
});

function routeBackedSource(headers: Record<string, string> = {}) {
  return createBackendMailboxSource({
    accountId: "acc-1",
    async request(input) {
      const response = await POST(
        new NextRequest(`http://localhost${input.path}`, {
          method: input.method,
          body: input.body ? JSON.stringify(input.body) : undefined,
          headers: { "content-type": "application/json", ...headers },
          signal: input.signal,
        }),
        { params: Promise.resolve({ accountId: "acc-1" }) } as never,
      );
      return {
        status: response.status,
        json: await response.json(),
      };
    },
  });
}

function enumerationInput() {
  return {
    session: { accountId: "acc-1", generation: "g1" },
    requestId: "r-enumeration",
    bootstrapId: "mailbox",
    page: JSON.stringify({ scopeId: "primary" }),
    pageSize: 10,
    signal: new AbortController().signal,
  };
}

function pagedResult() {
  return {
    bootstrapId: "mailbox",
    scopeId: "history",
    changes: [],
    requiredHydration: [],
    bodies: [],
    nextPage: "next",
    catchUpFrom: null,
  };
}
