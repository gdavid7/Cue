import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { adminPiiCleanupAction } from "./admin";

const { mockAuth, store, snapshots } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  store: new Map<string, unknown>(),
  // Like Redis, a scan keeps its place while keys are deleted along the way.
  snapshots: new Map<string, string[]>(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/env", () => ({
  env: {
    NEXT_PUBLIC_BRAND_NAME: "Inbox Zero",
    ADMINS: ["admin@example.com"],
    NODE_ENV: "test",
  },
}));
vi.mock("@/utils/redis", () => ({
  redis: {
    scan: vi.fn(async (cursor: string | number, { match, count }) => {
      const pattern = new RegExp(
        `^${String(match)
          .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
          .replace(/\*/g, ".*")}$`,
      );
      if (Number(cursor) === 0)
        snapshots.set(
          match,
          [...store.keys()].filter((key) => pattern.test(key)).sort(),
        );
      const all = snapshots.get(match) ?? [];
      const start = Number(cursor);
      const next = start + count >= all.length ? 0 : start + count;
      return [String(next), all.slice(start, start + count)];
    }),
    get: vi.fn(async (key: string) => store.get(key) ?? null),
    set: vi.fn(async (key: string, value: unknown) => {
      store.set(key, value);
      return "OK";
    }),
    unlink: vi.fn(
      async (...keys: string[]) =>
        keys.filter((key) => store.delete(key)).length,
    ),
    renamenx: vi.fn(async () => 0),
  },
}));

describe("adminPiiCleanupAction", () => {
  let output: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    snapshots.clear();
    output = [];
    for (const method of ["log", "info", "warn", "error"] as const)
      vi.spyOn(console, method).mockImplementation((...args) => {
        output.push(args.map(String).join(" "));
      });
    mockAuth.mockResolvedValue({
      user: { id: "admin-user", email: "admin@example.com" },
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each([
    ["signed out", null],
    ["a non-admin", { user: { id: "u2", email: "friend@example.com" } }],
  ])("rejects %s and touches nothing", async (_label, session) => {
    mockAuth.mockResolvedValue(session);
    store.set("reply:a1:m1", "Happy to meet");
    const { redis } = await import("@/utils/redis");

    const result = await adminPiiCleanupAction({ mode: "delete" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toBeDefined();
    expect(redis.scan).not.toHaveBeenCalled();
    expect(redis.unlink).not.toHaveBeenCalled();
    expect(store.size).toBe(1);
  });

  it("counts per pattern on a dry run and deletes nothing", async () => {
    store.set("reply:a1:m1", "Happy to meet");
    store.set("usage:me@example.com", { cost: 4 });
    store.set("decoy:me@example.com", "keep");
    const { redis } = await import("@/utils/redis");

    const result = await adminPiiCleanupAction({ mode: "dry-run" });

    expect(result?.data?.nextCursor).toBeNull();
    expect(result?.data?.counts["reply:*"]).toBe(1);
    expect(result?.data?.counts["usage:*@*"]).toBe(1);
    expect(redis.unlink).not.toHaveBeenCalled();
    expect(store.size).toBe(3);
  });

  it("deletes the listed patterns only, and resumes from the cursor", async () => {
    for (let i = 0; i < 700; i++) store.set(`linked-page:${i}`, "page");
    store.set("decoy:me@example.com", "keep");
    const { redis } = await import("@/utils/redis");
    // Each scan batch takes longer than the budget, so one call does one batch.
    const dateNow = vi.spyOn(Date, "now");
    let clock = 0;
    dateNow.mockImplementation(() => (clock += 60_000));

    const first = await adminPiiCleanupAction({ mode: "delete" });
    expect(first?.data?.nextCursor).toMatch(/^\d+:\d+$/);
    expect(store.size).toBe(701);

    let cursor = first?.data?.nextCursor;
    let deleted = first?.data?.counts["linked-page:*"] ?? 0;
    let calls = 1;
    while (cursor) {
      const next = await adminPiiCleanupAction({ mode: "delete", cursor });
      deleted += next?.data?.counts["linked-page:*"] ?? 0;
      cursor = next?.data?.nextCursor;
      calls++;
    }

    expect(calls).toBeGreaterThan(3);
    expect(deleted).toBe(700);
    expect([...store.keys()]).toEqual(["decoy:me@example.com"]);
    expect(redis.unlink).toHaveBeenCalled();
  });

  it("logs counts and patterns, never an address or a value", async () => {
    store.set("usage:me@example.com", { cost: 4, note: "secret-value" });
    store.set("processing-message:me@example.com:m1", "processed");
    store.set("reply:a1:m1", "secret-reply-text");

    await adminPiiCleanupAction({ mode: "delete" });

    const logged = output.join("\n");
    expect(logged).toContain("Redis PII cleanup step");
    expect(logged).not.toContain("me@example.com");
    expect(logged).not.toContain("secret-value");
    expect(logged).not.toContain("secret-reply-text");
    // The only "@" is the wildcard in a pattern such as usage:*@*.
    expect(logged.replace(/\*@\*/g, "")).not.toContain("@");
  });
});
