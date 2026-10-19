import { tool } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createTestLogger } from "@/__tests__/helpers";
import { runWithAuditContext } from "@/utils/audit/context";
import { describeProviderRateLimitError } from "@/utils/email/rate-limit";
import {
  currentGmailQuotaContext,
  meterGmailCall,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import { gmailQuotaStore } from "@/utils/gmail/quota-store";
import {
  CHAT_TOOL_GMAIL_WAIT_BUDGET_MS,
  withChatToolRuntime,
} from "./chat-tool-runtime";

vi.mock("server-only", () => ({}));
vi.mock("@/utils/gmail/quota-store", async () => {
  const { createMemoryGmailQuotaStore } = await import(
    "@/__tests__/mocks/gmail-quota-store.mock"
  );
  return { gmailQuotaStore: createMemoryGmailQuotaStore() };
});
vi.mock("@/utils/redis/email-provider-rate-limit", () => ({
  isEmailProviderRateLimitRedisConfigured: () => true,
  getEmailProviderRateLimitStateFromRedis: async () => null,
  setEmailProviderRateLimitStateInRedis: vi.fn(async () => undefined),
}));

const ACCOUNT = "account-1";
const toolCallOptions = { toolCallId: "call-1", messages: [] } as never;

describe("withChatToolRuntime", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    (gmailQuotaStore as unknown as { reset(): void }).reset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("charges a tool's Gmail calls as interactive whatever the surrounding work is", async () => {
    const tools = withChatToolRuntime({
      logger: createTestLogger(),
      tools: {
        searchInbox: tool({
          inputSchema: z.object({}),
          execute: async () => currentGmailQuotaContext(),
        }),
      },
    });

    for (const run of [
      <T>(fn: () => T) => runWithAuditContext({ source: "chat" }, fn),
      <T>(fn: () => T) =>
        runWithAuditContext({ source: "user/inbox-insights" }, fn),
      <T>(fn: () => T) =>
        runWithGmailQuota(
          { caller: "cron/digest", priority: "background" },
          fn,
        ),
    ]) {
      await expect(
        run(() => tools.searchInbox.execute?.({}, toolCallOptions)),
      ).resolves.toMatchObject({
        caller: "chat/searchInbox",
        priority: "interactive",
      });
    }
  });

  it("answers that Gmail is limiting instead of waiting call after call", async () => {
    // Sync has spent the bucket down to its floor.
    await runWithGmailQuota(
      { caller: "mail/v1/enumeration", priority: "sync" },
      () =>
        meterGmailCall({ emailAccountId: ACCOUNT, cost: 1200 }, async () => 1),
    );
    const gmailCalls = vi.fn(async () => "page");
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const tools = withChatToolRuntime({
      logger,
      tools: {
        searchContext: tool({
          inputSchema: z.object({}),
          execute: async () => {
            try {
              for (let page = 0; page < 6; page++) {
                await meterGmailCall(
                  { emailAccountId: ACCOUNT, cost: 600 },
                  gmailCalls,
                );
              }
              return { results: [] };
            } catch (error) {
              return { error: describeProviderRateLimitError(error, "google") };
            }
          },
        }),
      },
    });

    let output: unknown;
    Promise.resolve(tools.searchContext.execute?.({}, toolCallOptions)).then(
      (result: unknown) => {
        output = result;
      },
    );
    await vi.advanceTimersByTimeAsync(CHAT_TOOL_GMAIL_WAIT_BUDGET_MS);

    expect(output).toEqual({
      error: expect.stringMatching(
        /^Gmail is temporarily limiting requests; try again in about \d+ seconds?\.$/,
      ),
    });
    expect(gmailCalls.mock.calls.length).toBeLessThan(6);
    expect(warn).toHaveBeenCalledWith(
      "Assistant chat tool call finished",
      expect.objectContaining({
        tool: "searchContext",
        outcome: "error_result",
        errorCode: "GMAIL_CALL_DEFERRED",
        gmailDeferred: 1,
        gmailWaitMs: expect.any(Number),
      }),
    );
  });

  it("logs a thrown tool error with its duration and rethrows it", async () => {
    const logger = createTestLogger();
    const warn = vi.spyOn(logger, "warn");
    const failure = new TypeError("boom");
    const tools = withChatToolRuntime({
      logger,
      tools: {
        readEmail: tool({
          inputSchema: z.object({}),
          execute: async (): Promise<{ ok: true }> => {
            throw failure;
          },
        }),
      },
    });

    await expect(tools.readEmail.execute?.({}, toolCallOptions)).rejects.toBe(
      failure,
    );
    expect(warn).toHaveBeenCalledWith(
      "Assistant chat tool call finished",
      expect.objectContaining({
        tool: "readEmail",
        outcome: "threw",
        errorCode: "TypeError",
        durationMs: expect.any(Number),
      }),
    );
  });
});
