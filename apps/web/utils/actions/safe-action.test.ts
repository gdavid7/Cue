import { AsyncLocalStorage } from "node:async_hooks";
import { after } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureException } from "@/utils/error";
import {
  currentGmailQuotaContext,
  GmailCallDeferredError,
} from "@/utils/gmail/quota";
import { auth } from "@/utils/auth";
import prisma from "@/utils/prisma";
import { SESSION_EXPIRED_MESSAGE } from "@/utils/session-expired";
import {
  actionClient,
  actionClientUser,
  adminActionClient,
} from "./safe-action";

vi.mock("@/utils/prisma");
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/utils/auth", () => ({
  auth: vi.fn(async () => ({
    user: { id: "user-1", email: "user@example.com" },
  })),
}));
vi.mock("@/utils/error", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/utils/error")>()),
  captureException: vi.fn(),
}));

describe("server actions and the Gmail quota gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks the user to retry shortly when the gate deferred a Gmail call, without reporting it", async () => {
    const action = actionClientUser
      .metadata({ name: "bulkArchive" })
      .action(async () => {
        // Gaxios wraps errors thrown below it, as the gate's deferral is.
        throw Object.assign(new Error("request failed"), {
          cause: new GmailCallDeferredError(12_000, "interactive"),
        });
      });

    const result = await action();

    expect(result?.serverError).toBe(
      "Gmail is busy for this account. Try again in about 12 seconds.",
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it("charges an action's Gmail calls at the priority it declares, and a click when it declares none", async () => {
    const clicked = await actionClientUser
      .metadata({ name: "archiveThread" })
      .action(async () => currentGmailQuotaContext())();
    const bulk = await actionClientUser
      .metadata({ name: "bulkArchive", gmailPriority: "sync" })
      .action(async () => currentGmailQuotaContext())();

    expect(clicked?.data).toEqual({
      caller: "archiveThread",
      priority: "interactive",
    });
    expect(bulk?.data).toEqual({ caller: "bulkArchive", priority: "sync" });
  });

  it("runs work an action leaves for after the response as background", async () => {
    // Next runs after() callbacks in the context they were registered from.
    const callbacks: Array<() => unknown> = [];
    vi.mocked(after).mockImplementation((callback) => {
      callbacks.push(AsyncLocalStorage.bind(callback as () => unknown));
    });
    let afterResponse: unknown = null;
    const result = await actionClientUser
      .metadata({ name: "cleanInbox" })
      .action(async () => {
        after(() => {
          afterResponse = currentGmailQuotaContext();
        });
        return currentGmailQuotaContext();
      })();

    for (const callback of callbacks) await callback();

    expect(result?.data).toEqual({
      caller: "cleanInbox",
      priority: "interactive",
    });
    expect(afterResponse).toEqual({
      caller: "cleanInbox",
      priority: "background",
    });
  });
});

describe("server actions and revoked sessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The session cookie cache outlives a revocation; the database does not.
  it("rejects a revoked session at once in every signed-in action client", async () => {
    vi.mocked(auth).mockImplementation(async (_headers, options) =>
      options?.disableCookieCache
        ? null
        : ({ user: { id: "user-1", email: "user@example.com" } } as any),
    );
    const run = vi.fn();

    const results = await Promise.all([
      actionClient.metadata({ name: "sendEmail" }).action(run)("account-1"),
      actionClientUser.metadata({ name: "deleteAccount" }).action(run)(),
      adminActionClient.metadata({ name: "adminAction" }).action(run)(),
    ]);

    for (const result of results)
      expect(result?.serverError).toBe(SESSION_EXPIRED_MESSAGE);
    expect(run).not.toHaveBeenCalled();
  });

  // Next.js re-renders the open page, and can reload it, for any action that
  // sets a cookie, and reading the session from the database rewrites its cache.
  it("reads the session in every signed-in action client without writing a cookie", async () => {
    vi.mocked(auth).mockResolvedValue(null);

    await Promise.all([
      actionClient.metadata({ name: "sendEmail" }).action(vi.fn())("account-1"),
      actionClientUser.metadata({ name: "deleteAccount" }).action(vi.fn())(),
      adminActionClient.metadata({ name: "adminAction" }).action(vi.fn())(),
    ]);

    expect(vi.mocked(auth)).toHaveBeenCalledTimes(3);
    for (const [, options] of vi.mocked(auth).mock.calls)
      expect(options).toEqual({
        disableCookieCache: true,
        disableRefresh: true,
      });
  });
});

describe("server actions fired by the app with an expired session", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(auth).mockResolvedValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("answers a background action without a warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const info = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue(null);
    const run = vi.fn();

    const results = await Promise.all([
      actionClientUser
        .metadata({ name: "recordVisit", backgroundCall: true })
        .action(run)(),
      actionClient
        .metadata({ name: "assessUser", backgroundCall: true })
        .action(run)("account-1"),
    ]);

    for (const result of results)
      expect(result?.serverError).toBe(SESSION_EXPIRED_MESSAGE);
    expect(run).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining("Background action skipped: not signed in"),
    );
    expect(captureException).not.toHaveBeenCalled();
  });

  it("keeps the warning for an action the user triggered", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await Promise.all([
      actionClientUser.metadata({ name: "deleteAccount" }).action(vi.fn())(),
      actionClient.metadata({ name: "sendEmail" }).action(vi.fn())("account-1"),
    ]);

    const warnings = warn.mock.calls.map(([line]) => String(line));
    expect(warnings.some((line) => line.includes("Unauthorized"))).toBe(true);
    expect(
      warnings.filter((line) => line.includes("Server action error:")),
    ).toHaveLength(2);
  });

  it("still warns when a background call names an account owned by someone else", async () => {
    vi.mocked(auth).mockResolvedValue({
      user: { id: "user-1", email: "user@example.com" },
    } as any);
    vi.mocked(prisma.emailAccount.findUnique).mockResolvedValue({
      email: "other@example.com",
      account: { userId: "user-2", provider: "google" },
    } as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = vi.fn();

    const result = await actionClient
      .metadata({ name: "assessUser", backgroundCall: true })
      .action(run)("account-of-user-2");

    expect(result?.serverError).toBe("Unauthorized");
    expect(run).not.toHaveBeenCalled();
    const warnings = warn.mock.calls.map(([line]) => String(line));
    expect(warnings.some((line) => line.includes("Unauthorized"))).toBe(true);
  });
});
