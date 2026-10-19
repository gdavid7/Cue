import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { redis } from "@/utils/redis";
import prisma from "@/utils/prisma";
import { GET } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({ env: {} }));
vi.mock("@/utils/middleware", async () => {
  const { createWithAuthTestMiddleware } = await import("@/__tests__/helpers");
  return createWithAuthTestMiddleware();
});
vi.mock("@/utils/redis", () => ({
  redis: { mget: vi.fn(), get: vi.fn(), set: vi.fn() },
}));
vi.mock("@/utils/prisma", () => ({
  default: { emailAccount: { findUnique: vi.fn() } },
}));

// Redis as the push path and the ownership flag leave it, keyed like the app.
// RD-3: the flag is "1", never the account's address.
let store: Record<string, unknown>;

describe("Mail version poll", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    store = {
      "account-owner:user-1:acc-a": "1",
      "account-owner:user-1:acc-b": "1",
      "local-mail-version:acc-a": "v1",
    };
    vi.mocked(redis.mget).mockImplementation((async (...keys: string[]) =>
      keys.map((key) => store[key] ?? null)) as never);
    vi.mocked(redis.get).mockImplementation(
      (async (key: string) => store[key] ?? null) as never,
    );
    vi.mocked(redis.set).mockResolvedValue("OK");
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(null);
  });

  it("answers with each owned account's version in one Redis read", async () => {
    const response = await GET(request("acc-a,acc-b"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      versions: { "acc-a": "v1", "acc-b": null },
    });
    expect(redis.mget).toHaveBeenCalledOnce();
    expect(redis.get).not.toHaveBeenCalled();
  });

  it("answers 304 while nothing changed, and the new version once a push lands", async () => {
    const first = await GET(request("acc-a,acc-b"));
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();

    const unchanged = await GET(request("acc-a,acc-b", etag));
    expect(unchanged.status).toBe(304);

    store["local-mail-version:acc-b"] = "v7";
    const changed = await GET(request("acc-a,acc-b", etag));
    expect(changed.status).toBe(200);
    expect(changed.headers.get("etag")).not.toBe(etag);
    expect((await changed.json()).versions["acc-b"]).toBe("v7");
  });

  it("leaves out accounts the user does not own", async () => {
    store["local-mail-version:acc-other"] = "secret";

    const response = await GET(request("acc-a,acc-other"));

    expect((await response.json()).versions).toEqual({ "acc-a": "v1" });
  });

  it("checks ownership in the database when it is not cached", async () => {
    store["account-owner:user-1:acc-b"] = null;
    store["local-mail-version:acc-b"] = "v2";
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      id: "acc-b",
    } as never);

    const response = await GET(request("acc-b"));

    expect((await response.json()).versions).toEqual({ "acc-b": "v2" });
    // Remembered by id alone, so the next poll needs no database read.
    expect(redis.set).toHaveBeenCalledWith("account-owner:user-1:acc-b", "1", {
      ex: 3600,
    });
  });

  it("tells the browser to sync directly when Redis is unavailable", async () => {
    vi.mocked(redis.mget).mockRejectedValue(new Error("Unavailable"));

    expect((await GET(request("acc-a"))).status).toBe(503);
  });

  it("rejects a request without accounts", async () => {
    expect((await GET(request(""))).status).toBe(400);
  });
});

function request(ids: string, etag?: string | null) {
  return new NextRequest(
    `http://localhost/api/mail-version?emailAccountIds=${ids}`,
    { headers: etag ? { "If-None-Match": etag } : {} },
  );
}
