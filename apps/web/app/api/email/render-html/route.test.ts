import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { rateLimitCounts, rewriteHtmlForImageProxyMock } = vi.hoisted(() => ({
  rateLimitCounts: new Map<string, number>(),
  rewriteHtmlForImageProxyMock: vi.fn(),
}));

vi.mock("@/utils/redis", () => ({
  redis: {
    eval: async (_script: string, [key]: string[]) => {
      const count = (rateLimitCounts.get(key) ?? 0) + 1;
      rateLimitCounts.set(key, count);
      return count;
    },
  },
}));
vi.mock("@/utils/email/image-proxy.server", () => ({
  rewriteHtmlForImageProxy: rewriteHtmlForImageProxyMock,
}));
vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await vi.importActual<
    typeof import("@/__tests__/helpers")
  >("@/__tests__/helpers");

  return createWithAuthTestMiddleware();
});

import { POST } from "./route";

describe("email render-html route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    rateLimitCounts.clear();
    rewriteHtmlForImageProxyMock.mockImplementation(async (html: string) => ({
      html,
      remoteAssetsProxied: true,
    }));
  });

  it("stops minting proxy URLs for a user after a burst of requests", async () => {
    const render = () =>
      POST(
        new NextRequest("http://localhost/api/email/render-html", {
          body: JSON.stringify({
            html: '<img src="https://example.com/a.png">',
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
        }),
        {} as never,
      );

    const statuses: number[] = [];
    for (let index = 0; index < 1000; index++) {
      statuses.push((await render()).status);
    }

    expect(statuses[0]).toBe(200);
    expect(statuses.at(-1)).toBe(429);
    expect(rewriteHtmlForImageProxyMock.mock.calls.length).toBeLessThan(1000);
  });
});
