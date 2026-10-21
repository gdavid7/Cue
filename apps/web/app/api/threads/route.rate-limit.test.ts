import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { auth } from "@/utils/auth";
import { EMAIL_ACCOUNT_HEADER } from "@/utils/config";
import { createEmailProvider } from "@/utils/email/provider";
import { GmailCallDeferredError } from "@/utils/gmail/quota";
import { GET as getBasicThreads } from "./basic/route";
import { GET as getThreadsBatch } from "./batch/route";
import { GET as getThreads } from "./route";

vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: vi.fn() }));
vi.mock("@/utils/email/provider", () => ({ createEmailProvider: vi.fn() }));
vi.mock("@/utils/error.server");
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => false,
}));

const EMAIL_ACCOUNT_ID = "account-threads-rate-limit";
const routes = [
  { name: "threads", get: getThreads, path: "/api/threads" },
  {
    name: "threads/basic",
    get: getBasicThreads,
    path: "/api/threads/basic?fromEmail=a%40example.com",
  },
  {
    name: "threads/batch",
    get: getThreadsBatch,
    path: "/api/threads/batch?threadIds=t1,t2",
  },
];

// The middleware answers a quota deferral with 503 and a Gmail rate limit
// with 429, each with Retry-After, so the client knows when to come back.
describe("threads routes under Gmail's quota", () => {
  beforeEach(() => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
      session: {},
    } as Awaited<ReturnType<typeof auth>>);
    prisma.emailAccount.findUnique.mockResolvedValue({
      userId: "user-1",
      email: "user@example.com",
      account: { provider: "google" },
    } as never);
  });

  for (const route of routes) {
    it(`${route.name} lets a quota deferral reach the middleware`, async () => {
      failGmailWith(() => new GmailCallDeferredError(12_000, "interactive"));

      const response = await route.get(request(route.path), context());

      expect(response.status).toBe(503);
      expect(response.headers.get("Retry-After")).toBe("12");
    });

    it(`${route.name} lets a Gmail rate limit reach the middleware`, async () => {
      failGmailWith(() =>
        Object.assign(new Error("User-rate limit exceeded"), {
          status: 403,
          errors: [{ reason: "rateLimitExceeded" }],
        }),
      );

      const response = await route.get(request(route.path), context());

      expect(response.status).toBe(429);
      expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
    });
  }

  it("answers a provider throttle the error helpers don't name with 429 too", async () => {
    failGmailWith(
      () =>
        new Error("Batch request failed", {
          cause: Object.assign(new Error("Provider request was throttled"), {
            response: { status: 429 },
          }),
        }),
    );

    const response = await getBasicThreads(
      request("/api/threads/basic?fromEmail=a%40example.com"),
      context(),
    );

    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("threads/batch still returns the threads it loaded when one fails for another reason", async () => {
    vi.mocked(createEmailProvider).mockResolvedValue({
      name: "google",
      getThread: vi.fn(async (id: string) => {
        if (id === "t2") throw new Error("Not Found");
        return { id, messages: [{ id: "m1", headers: {} }], snippet: "" };
      }),
    } as never);

    const response = await getThreadsBatch(
      request("/api/threads/batch?threadIds=t1,t2"),
      context(),
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      threads: [{ id: "t1" }],
    });
  });
});

function failGmailWith(error: () => Error) {
  const fail = vi.fn(async () => {
    throw error();
  });
  vi.mocked(createEmailProvider).mockResolvedValue({
    name: "google",
    getThread: fail,
    getThreads: fail,
    getThreadsWithQuery: fail,
    getThreadsWithParticipant: fail,
    searchThreads: fail,
    getLabels: fail,
  } as never);
}

function request(path: string) {
  return new NextRequest(`http://localhost${path}`, {
    headers: { [EMAIL_ACCOUNT_HEADER]: EMAIL_ACCOUNT_ID },
  });
}

function context() {
  return { params: Promise.resolve({}) };
}
