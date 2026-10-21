import { beforeEach, describe, expect, it, vi } from "vitest";
import { recordingRedis } from "@/__tests__/mocks/recording-redis.mock";
import prisma from "@/utils/__mocks__/prisma";
import { runWithAuditContext, setAuditContext } from "@/utils/audit/context";
import { recordAuditEvent } from "@/utils/audit/delivery";
import { __testing__ as auditExtension } from "@/utils/audit/prisma-extension";
import {
  getEmailAccount,
  invalidateAccountOwnership,
  readKeyForOwnedAccounts,
  startEmailAccountOwnershipCheck,
} from "./account-validation";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/prisma");
vi.mock("@/utils/audit/delivery", () => ({
  isAuditLoggingEnabled: () => true,
  recordAuditEvent: vi.fn(),
}));
vi.mock("@/utils/redis", async () => ({
  redis: (await import("@/__tests__/mocks/recording-redis.mock")).recordingRedis
    .client,
}));

describe("getEmailAccount", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingRedis.reset();
  });

  it("returns the address of an account the user owns", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      email: "me@example.com",
    } as never);

    expect(
      await getEmailAccount({ userId: "user-1", emailAccountId: "account-1" }),
    ).toBe("me@example.com");
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-1", userId: "user-1" },
      select: { email: true },
    });
  });

  it("returns null for an account the user does not own", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    expect(
      await getEmailAccount({ userId: "user-1", emailAccountId: "account-2" }),
    ).toBeNull();
  });

  // RD-3: the address is personal data, so it is never cached server-side,
  // and an account moved to another user is refused on the very next check.
  it("keeps the address out of the cache and sees a transfer at once", async () => {
    prisma.emailAccount.findUnique.mockResolvedValueOnce({
      email: "me@example.com",
    } as never);
    const key = { userId: "user-1", emailAccountId: "account-1" };
    expect(await getEmailAccount(key)).toBe("me@example.com");

    prisma.emailAccount.findUnique.mockResolvedValueOnce(null);
    expect(await getEmailAccount(key)).toBeNull();
    expect(recordingRedis.everythingWritten()).not.toContain("me@example.com");
  });
});

describe("startEmailAccountOwnershipCheck", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingRedis.reset();
  });

  it("answers with the address and provider only for the account's owner", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      userId: "user-1",
      email: "me@example.com",
      account: { provider: "google" },
    } as never);

    const check = startEmailAccountOwnershipCheck("account-1");

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledWith({
      where: { id: "account-1" },
      select: {
        userId: true,
        email: true,
        account: { select: { provider: true } },
      },
    });
    expect(await check("user-1")).toEqual({
      email: "me@example.com",
      provider: "google",
    });
    expect(await check("user-2")).toBeNull();
    expect(await check("")).toBeNull();
    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(recordingRedis.everythingWritten()).not.toContain("me@example.com");
  });

  it("answers null for an account that does not exist", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    expect(
      await startEmailAccountOwnershipCheck("missing")("user-1"),
    ).toBeNull();
  });

  it("passes a failed read to the check, and only to it", async () => {
    prisma.emailAccount.findUnique.mockRejectedValue(new Error("db down"));

    // Never checked, as for a request without a session: no unhandled
    // rejection fails this test.
    startEmailAccountOwnershipCheck("account-1");
    const check = startEmailAccountOwnershipCheck("account-1");

    await expect(check("user-1")).rejects.toThrow("db down");
  });

  // The request's audit context gains the caller once the session resolves,
  // and the audit extension reads it when the query finishes; the read made
  // before that is the pre-auth check's, whatever finishes first.
  it("audits the read as a pre-auth check, not as the caller", async () => {
    let finishQuery: () => void = () => undefined;
    const queryFinished = new Promise<void>((resolve) => {
      finishQuery = resolve;
    });
    prisma.emailAccount.findUnique.mockImplementation(((args: unknown) =>
      lazyAuditedQuery(args, async () => {
        await queryFinished;
        return {
          userId: "someone-else",
          email: "me@example.com",
          account: { provider: "google" },
        };
      })) as never);

    await runWithAuditContext(
      { actorType: "anonymous", requestId: "request-1", source: "api/test" },
      async () => {
        const check = startEmailAccountOwnershipCheck("account-1");
        setAuditContext({ actorType: "user", userId: "caller" });
        finishQuery();
        expect(await check("caller")).toBeNull();
      },
    );

    expect(recordAuditEvent).toHaveBeenCalledTimes(1);
    expect(recordAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        model: "EmailAccount",
        operation: "findUnique",
        status: "success",
        result_count: 1,
        actor_type: "pre_auth",
        user_id: null,
        email_account_id: null,
        api_key_id: null,
        request_id: "request-1",
        source: "api/test",
      }),
    );
  });
});

// Like a Prisma query: it runs, audited, on first use, in the async context
// of that use, and only once.
function lazyAuditedQuery(args: unknown, query: () => Promise<unknown>) {
  let started: Promise<unknown> | undefined;
  const run = () =>
    (started ??= auditExtension.auditPrismaOperation({
      model: "EmailAccount",
      operation: "findUnique",
      args,
      query,
    }));
  return {
    // biome-ignore lint/suspicious/noThenProperty: models a Prisma thenable
    then: (
      onFulfilled?: (value: unknown) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => run().then(onFulfilled, onRejected),
    catch: (onRejected: (reason: unknown) => unknown) =>
      run().catch(onRejected),
  };
}

describe("account ownership in Redis", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    recordingRedis.reset();
  });

  // RD-3: the flag is "1" under ids; the address never reaches Redis.
  it("remembers an owned account by id alone and asks the database once", async () => {
    prisma.emailAccount.findUnique.mockResolvedValue({
      id: "account-1",
    } as never);
    recordingRedis.store.set("version:account-1", "v1");

    expect(Object.fromEntries(await read())).toEqual({ "account-1": "v1" });
    expect(Object.fromEntries(await read())).toEqual({ "account-1": "v1" });

    expect(prisma.emailAccount.findUnique).toHaveBeenCalledTimes(1);
    expect(recordingRedis.writes).toEqual([
      { key: "account-owner:user-1:account-1", value: "1" },
    ]);
  });

  it("asks the database again once ownership is forgotten", async () => {
    prisma.emailAccount.findUnique.mockResolvedValueOnce({
      id: "account-1",
    } as never);
    recordingRedis.store.set("version:account-1", "v1");
    await read();

    await invalidateAccountOwnership({
      userId: "user-1",
      emailAccountId: "account-1",
    });
    prisma.emailAccount.findUnique.mockResolvedValueOnce(null);

    expect(Object.fromEntries(await read())).toEqual({});
  });

  it("reads each owned account's key and leaves out the rest", async () => {
    recordingRedis.store.set("account-owner:user-1:account-1", "1");
    recordingRedis.store.set("version:account-1", "v1");
    recordingRedis.store.set("version:account-2", "v2");
    prisma.emailAccount.findUnique.mockResolvedValue(null);

    const owned = await readKeyForOwnedAccounts({
      userId: "user-1",
      emailAccountIds: ["account-1", "account-2"],
      keyFor: (id) => `version:${id}`,
    });

    expect(Object.fromEntries(owned)).toEqual({ "account-1": "v1" });
  });
});

function read() {
  return readKeyForOwnedAccounts({
    userId: "user-1",
    emailAccountIds: ["account-1"],
    keyFor: (id) => `version:${id}`,
  });
}
