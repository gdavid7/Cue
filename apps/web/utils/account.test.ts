import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  cookies: vi.fn(),
  findFirst: vi.fn(),
  findMany: vi.fn(),
  flushLoggerSafely: vi.fn(),
  after: vi.fn(),
  env: {
    NODE_ENV: "test",
    AXIOM_TOKEN: undefined,
    NEXT_PUBLIC_LOG_SCOPES: undefined,
    ENABLE_DEBUG_LOGS: false,
  },
  redirect: vi.fn((url: string) => {
    throw new Error(`redirect:${url}`);
  }),
}));

vi.mock("@/utils/auth", () => ({
  auth: () => mocks.auth(),
}));

vi.mock("next/headers", () => ({
  cookies: () => mocks.cookies(),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => mocks.redirect(url),
}));

vi.mock("next/server", () => ({
  after: (callback: () => void | Promise<void>) => mocks.after(callback),
}));

vi.mock("@/env", () => ({
  env: mocks.env,
}));

vi.mock("@/utils/logger-flush", () => ({
  flushLoggerSafely: (...args: unknown[]) => mocks.flushLoggerSafely(...args),
}));

vi.mock("@/utils/prisma", () => ({
  default: {
    emailAccount: {
      findFirst: (...args: Parameters<typeof mocks.findFirst>) =>
        mocks.findFirst(...args),
      findMany: (...args: Parameters<typeof mocks.findMany>) =>
        mocks.findMany(...args),
    },
  },
}));

import { redirectToEmailAccountPath } from "./account";

describe("redirectToEmailAccountPath", () => {
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mocks.auth.mockResolvedValue({ user: { id: "user_123" } });
    mocks.cookies.mockResolvedValue({ get: () => undefined });
  });

  it("sends authenticated users without an email account to mailbox connection", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(redirectToEmailAccountPath("/setup")).rejects.toThrow(
      "redirect:/connect-mailbox?next=%2Fsetup",
    );

    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { userId: "user_123" },
      select: { id: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(getAccountRedirectLog(consoleLogSpy)).toEqual(
      expect.objectContaining({
        path: "/setup",
        outcome: "connect-mailbox",
        usedLastEmailAccountCookie: false,
        usedFallbackAccountLookup: true,
        foundEmailAccount: false,
        durationMs: expect.any(Number),
        stepDurationsMs: expect.objectContaining({
          auth: expect.any(Number),
          "last-email-account-cookie": expect.any(Number),
          "fallback-email-account-lookup": expect.any(Number),
        }),
      }),
    );
    expect(mocks.after).toHaveBeenCalledOnce();
    expect(mocks.redirect).toHaveBeenCalledWith(
      "/connect-mailbox?next=%2Fsetup",
    );
  });

  it("preserves search params when sending users to mailbox connection", async () => {
    mocks.findFirst.mockResolvedValue(null);

    await expect(
      redirectToEmailAccountPath("/setup", {
        source: "checkout",
        step: ["one", "two"],
      }),
    ).rejects.toThrow(
      "redirect:/connect-mailbox?next=%2Fsetup%3Fsource%3Dcheckout%26step%3Done%26step%3Dtwo",
    );

    expect(mocks.redirect).toHaveBeenCalledWith(
      "/connect-mailbox?next=%2Fsetup%3Fsource%3Dcheckout%26step%3Done%26step%3Dtwo",
    );
    expect(getAccountRedirectLog(consoleLogSpy)).toEqual(
      expect.objectContaining({
        searchParamKeys: ["source", "step"],
      }),
    );
  });

  it("reuses a session the caller already resolved", async () => {
    mocks.findFirst.mockResolvedValue({ id: "account_456" });

    await expect(
      redirectToEmailAccountPath("/setup", undefined, {
        user: { id: "user_456" },
      } as Parameters<typeof redirectToEmailAccountPath>[2]),
    ).rejects.toThrow("redirect:/account_456/setup");

    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: "user_456" } }),
    );
  });

  it("uses the last email account cookie after confirming it still exists", async () => {
    mocks.cookies.mockResolvedValue({
      get: () => ({
        value: JSON.stringify({
          userId: "user_123",
          emailAccountId: "account_123",
        }),
      }),
    });
    mocks.findFirst.mockResolvedValue({ id: "account_123" });

    await expect(redirectToEmailAccountPath("/setup")).rejects.toThrow(
      "redirect:/account_123/setup",
    );

    expect(mocks.findFirst).toHaveBeenCalledTimes(1);
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { id: "account_123", userId: "user_123" },
      select: { id: true },
    });
    expect(getAccountRedirectLog(consoleLogSpy)).toEqual(
      expect.objectContaining({
        path: "/setup",
        outcome: "account-path",
        usedLastEmailAccountCookie: true,
        usedFallbackAccountLookup: false,
        foundEmailAccount: true,
        stepDurationsMs: expect.not.objectContaining({
          "fallback-email-account-lookup": expect.any(Number),
        }),
      }),
    );
  });

  it("falls back to the first remaining account when the last-account cookie is stale", async () => {
    mockLastEmailAccountCookie("deleted_account");
    mocks.findMany.mockResolvedValue([
      accountRow("account_remaining"),
      accountRow("account_other"),
    ]);

    await expect(redirectToEmailAccountPath("/mail")).rejects.toThrow(
      "redirect:/mail/u/0/inbox",
    );

    expect(getAccountRedirectLog(consoleLogSpy)).toEqual(
      expect.objectContaining({
        path: "/mail",
        outcome: "account-path",
        usedLastEmailAccountCookie: false,
        usedFallbackAccountLookup: true,
        foundEmailAccount: true,
      }),
    );
  });

  it("finds the last-used mailbox from the account list alone", async () => {
    mockLastEmailAccountCookie("account_second");
    mocks.findMany.mockResolvedValue([
      accountRow("account_first"),
      accountRow("account_second"),
    ]);

    await expect(redirectToEmailAccountPath("/mail")).rejects.toThrow(
      "redirect:/mail/u/1/inbox",
    );
    expect(mocks.findFirst).not.toHaveBeenCalled();
    expect(mocks.findMany).toHaveBeenCalledWith({
      where: { userId: "user_123" },
      select: {
        id: true,
        email: true,
        account: { select: { provider: true } },
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    });
    expect(getAccountRedirectLog(consoleLogSpy)).toEqual(
      expect.objectContaining({
        usedLastEmailAccountCookie: true,
        usedFallbackAccountLookup: false,
        stepDurationsMs: {
          auth: expect.any(Number),
          "email-accounts": expect.any(Number),
        },
      }),
    );
  });

  it("ignores a last-account cookie written for another user", async () => {
    mocks.cookies.mockResolvedValue({
      get: () => ({
        value: JSON.stringify({
          userId: "someone_else",
          emailAccountId: "account_second",
        }),
      }),
    });
    mocks.findMany.mockResolvedValue([
      accountRow("account_first"),
      accountRow("account_second"),
    ]);

    await expect(redirectToEmailAccountPath("/mail")).rejects.toThrow(
      "redirect:/mail/u/0/inbox",
    );
  });

  it("keeps a thread link on the first account when the cookie is stale", async () => {
    mockLastEmailAccountCookie("deleted_account");
    mocks.findMany.mockResolvedValue([accountRow("account_first")]);

    await expect(
      redirectToEmailAccountPath("/mail", { "thread-id": "t1" }),
    ).rejects.toThrow("redirect:/mail/u/0/inbox/t1");
  });

  it("sends a user with no accounts from mail to mailbox connection", async () => {
    mocks.findMany.mockResolvedValue([]);

    await expect(
      redirectToEmailAccountPath("/mail", { type: "sent" }),
    ).rejects.toThrow("redirect:/connect-mailbox?next=%2Fmail%3Ftype%3Dsent");
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("sends a signed-out user to log in and back to the same mail", async () => {
    mocks.auth.mockResolvedValue(null);

    await expect(
      redirectToEmailAccountPath("/mail", { type: "sent" }),
    ).rejects.toThrow("redirect:/login?next=%2Fmail%3Ftype%3Dsent");
    expect(mocks.findMany).not.toHaveBeenCalled();
  });

  it("keeps a mail view and unrelated params when redirecting to mail", async () => {
    mocks.findMany.mockResolvedValue([accountRow("account_123")]);

    await expect(
      redirectToEmailAccountPath("/mail", { type: "sent", checkout: "done" }),
    ).rejects.toThrow("redirect:/mail/u/0/sent?checkout=done");
  });
});

function getAccountRedirectLog(consoleLogSpy: ReturnType<typeof vi.spyOn>) {
  const logCall = [...consoleLogSpy.mock.calls]
    .reverse()
    .find(
      ([message]) =>
        typeof message === "string" &&
        message.includes("[account-redirect]: Resolved account redirect"),
    );

  expect(logCall).toBeDefined();

  const message = logCall?.[0];
  expect(typeof message).toBe("string");

  const jsonStart = (message as string).indexOf("{");
  expect(jsonStart).toBeGreaterThanOrEqual(0);

  return JSON.parse((message as string).slice(jsonStart));
}

function mockLastEmailAccountCookie(emailAccountId: string) {
  mocks.cookies.mockResolvedValue({
    get: () => ({
      value: JSON.stringify({ userId: "user_123", emailAccountId }),
    }),
  });
}

function accountRow(id: string) {
  return { id, email: `${id}@example.com`, account: { provider: "google" } };
}
