import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MockInstance } from "vitest";
import prisma from "@/utils/__mocks__/prisma";
import { redis } from "@/utils/redis";
import { recordActivationSignalAction } from "./activation";

const { mockAuth } = vi.hoisted(() => ({ mockAuth: vi.fn() }));

vi.mock("server-only", () => ({}));
vi.mock("@sentry/nextjs", () => import("@/__tests__/mocks/sentry-nextjs.mock"));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/utils/prisma");
vi.mock("@/utils/auth", () => ({ auth: mockAuth }));
vi.mock("@/utils/redis", () => ({ redis: { set: vi.fn() } }));

const SIGNED_IN_AT = new Date("2026-10-16T09:00:00.000Z");

describe("recordActivationSignalAction", () => {
  let logSpy: MockInstance<typeof console.log>;
  // Redis answers "OK" only to the first claim of a key, like SET NX.
  let claimed: Set<string>;

  beforeEach(() => {
    vi.clearAllMocks();
    claimed = new Set();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockAuth.mockResolvedValue({ user: { id: "user-1", email: "me@x.test" } });
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@x.test",
      createdAt: SIGNED_IN_AT,
      account: { userId: "user-1", provider: "google" },
    } as never);
    vi.mocked(redis.set).mockImplementation((async (key: string) => {
      if (claimed.has(key)) return null;
      claimed.add(key);
      return "OK";
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  it.each([
    ["first_sync_ready", "activation.first_sync_ready"],
    ["first_thread_opened", "activation.first_thread_opened"],
    ["first_triage_action", "activation.first_triage_action"],
  ] as const)("logs %s once and ignores a repeat", async (event, message) => {
    const mailbox = `mailbox-${event}`;
    const first = await recordActivationSignalAction(mailbox, { event });
    const second = await recordActivationSignalAction(mailbox, { event });

    expect(first?.serverError).toBeUndefined();
    expect(second?.serverError).toBeUndefined();
    const events = loggedEvents().filter((entry) => entry.event === message);
    expect(events).toHaveLength(1);
    expect(events[0].fields.emailAccountId).toBe(mailbox);
    expect(redis.set).toHaveBeenCalledWith(
      expect.stringContaining(mailbox),
      "1",
      { nx: true, ex: expect.any(Number) },
    );
  });

  it("reports the time since first sign-in with the first sync", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-16T09:03:00.000Z") });
    try {
      await recordActivationSignalAction("mailbox-timing", {
        event: "first_sync_ready",
      });
    } finally {
      vi.useRealTimers();
    }

    expect(loggedEvents()[0].fields.msSinceFirstSignIn).toBe(3 * 60 * 1000);
  });

  it("logs nothing but the mailbox id and times", async () => {
    await recordActivationSignalAction("mailbox-pii", {
      event: "first_triage_action",
    });

    expect(Object.keys(loggedEvents()[0].fields).sort()).toEqual([
      "at",
      "emailAccountId",
    ]);
  });

  it("rejects an event outside the allowed set", async () => {
    const result = await recordActivationSignalAction("mailbox-bad", {
      event: "first_sign_in",
    } as never);

    expect(result?.validationErrors).toBeDefined();
    expect(redis.set).not.toHaveBeenCalled();
    expect(loggedEvents()).toEqual([]);
  });

  it("rejects another user's mailbox", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "other@x.test",
      createdAt: SIGNED_IN_AT,
      account: { userId: "user-2", provider: "google" },
    } as never);

    const result = await recordActivationSignalAction("mailbox-other", {
      event: "first_thread_opened",
    });

    expect(result?.serverError).toBe("Unauthorized");
    expect(redis.set).not.toHaveBeenCalled();
    expect(loggedEvents()).toEqual([]);
  });

  function loggedEvents() {
    return logSpy.mock.calls.flatMap(([line]: unknown[]) => {
      const match = String(line).match(
        /^\[product\]: (activation\.\S+) ([\s\S]*)$/,
      );
      if (!match) return [];
      return [
        {
          event: match[1],
          fields: JSON.parse(match[2]) as Record<string, unknown>,
        },
      ];
    });
  }
});
