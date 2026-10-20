import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "@/__tests__/mocks/sentry-nextjs.mock";
import { adminPiiCleanupAction } from "./admin";

const { mockAuth, fake, spies } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  fake: {} as {
    current: ReturnType<
      typeof import("@/__tests__/redis/fake-cleanup-redis").fakeCleanupRedis
    >;
  },
  spies: {} as Record<string, ReturnType<typeof vi.fn>>,
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
vi.mock("@/utils/redis", async () => {
  const { fakeCleanupRedis } = await import(
    "@/__tests__/redis/fake-cleanup-redis"
  );
  fake.current = fakeCleanupRedis();
  const client = fake.current.client;
  for (const command of ["scan", "get", "mget", "set", "unlink", "renamenx"])
    spies[command] = vi.fn((...args: unknown[]) =>
      (client as Record<string, (...a: unknown[]) => unknown>)[command](
        ...args,
      ),
    );
  return { redis: spies };
});

describe("adminPiiCleanupAction", () => {
  let output: string[];

  beforeEach(() => {
    vi.clearAllMocks();
    fake.current.reset();
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
    fake.current.store.set("reply:a1:m1", "Happy to meet");

    const result = await adminPiiCleanupAction({ mode: "delete" });

    expect(result?.data).toBeUndefined();
    expect(result?.serverError).toBeDefined();
    expect(spies.scan).not.toHaveBeenCalled();
    expect(spies.unlink).not.toHaveBeenCalled();
    expect(fake.current.store.size).toBe(1);
  });

  it("counts per pattern on a dry run and deletes nothing", async () => {
    const { store } = fake.current;
    store.set("reply:a1:m1", "Happy to meet");
    store.set("usage:me@example.com", { cost: 4 });
    store.set("decoy:me@example.com", "keep");

    const result = await adminPiiCleanupAction({ mode: "dry-run" });

    expect(result?.data?.nextCursor).toBeNull();
    expect(result?.data?.counts["reply:*"]).toBe(1);
    expect(result?.data?.counts["usage:*@*"]).toBe(1);
    expect(spies.unlink).not.toHaveBeenCalled();
    expect(store.size).toBe(3);
  });

  it("deletes the listed patterns only, and resumes from the cursor", async () => {
    const { store } = fake.current;
    for (let i = 0; i < 700; i++) store.set(`linked-page:${i}`, "page");
    store.set("decoy:me@example.com", "keep");
    // Each scan batch takes longer than the budget, so one call does one batch.
    let clock = 0;
    vi.spyOn(Date, "now").mockImplementation(() => (clock += 60_000));

    const first = await adminPiiCleanupAction({ mode: "delete" });
    expect(first?.data?.nextCursor).toMatch(/^[1-9]\d*$/);
    expect(store.size).toBeGreaterThan(300);

    let cursor = first?.data?.nextCursor;
    let deleted = first?.data?.counts["linked-page:*"] ?? 0;
    let calls = 1;
    while (cursor) {
      const next = await adminPiiCleanupAction({ mode: "delete", cursor });
      deleted += next?.data?.counts["linked-page:*"] ?? 0;
      cursor = next?.data?.nextCursor;
      calls++;
    }

    expect(calls).toBeGreaterThan(1);
    expect(deleted).toBe(700);
    expect([...store.keys()]).toEqual(["decoy:me@example.com"]);
  });

  it("logs counts and patterns, never an address or a value", async () => {
    const { store } = fake.current;
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

  it("keeps the key a failing Redis command quotes out of logs and Sentry", async () => {
    const { store } = fake.current;
    store.set("usage:me@example.com", { cost: 4, note: "secret-value" });
    spies.unlink.mockImplementationOnce(async (...keys: string[]) => {
      throw new Error(
        `ERR timeout, command was: ${JSON.stringify(["UNLINK", ...keys])}`,
      );
    });

    const result = await adminPiiCleanupAction({ mode: "delete" });

    expect(result?.serverError).toBeDefined();
    const leaked = [
      output.join("\n"),
      JSON.stringify(
        captureException.mock.calls.map(([error, context]) => [
          error instanceof Error ? error.message : String(error),
          error instanceof Error ? String(error.cause ?? "") : "",
          context,
        ]),
      ),
      JSON.stringify(result),
    ].join("\n");
    expect(leaked).not.toContain("me@example.com");
    expect(leaked).not.toContain("secret-value");
    expect(output.join("\n")).toContain(
      "Redis command failed during PII cleanup",
    );
  });
});
