import { describe, expect, it, vi } from "vitest";
import { APICallError } from "ai";
import { Prisma } from "@/generated/prisma/client";
import prisma from "@/utils/prisma";
import { createTestLogger } from "@/__tests__/helpers";
import { AutomatedAiCallTimeoutError } from "@/utils/llms/automated-call-bound";
import {
  isTransientMessageProcessingError,
  recordMessageProcessingFailure,
} from "./message-processing-failure";

vi.mock("@/utils/prisma", () => ({
  default: {
    executedRule: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({}),
    },
  },
}));

describe("recordMessageProcessingFailure", () => {
  it("leaves a message alone when something was recorded for it already", async () => {
    vi.mocked(prisma.executedRule.findFirst).mockResolvedValueOnce({
      id: "existing",
    } as any);

    await recordMessageProcessingFailure({
      emailAccountId: "account-1",
      messageId: "message-1",
      threadId: "thread-1",
      logger: createTestLogger(),
    });

    expect(prisma.executedRule.create).not.toHaveBeenCalled();
  });
});

const outOfCredits = new APICallError({
  message: "You exceeded your current quota",
  url: "https://api.example.com",
  requestBodyValues: {},
  statusCode: 402,
  isRetryable: true,
});
const anthropicBalanceTooLow = new APICallError({
  message: "Your credit balance is too low to access the Anthropic API",
  url: "https://api.example.com",
  requestBodyValues: {},
  statusCode: 400,
});

describe("isTransientMessageProcessingError", () => {
  it.each([
    {
      failure: "an overloaded AI provider",
      error: Object.assign(new Error("Overloaded"), { statusCode: 529 }),
    },
    {
      failure: "an AI provider rate limit",
      error: Object.assign(new Error("Too many requests"), { status: 429 }),
    },
    {
      failure: "an AI call out of time",
      error: new AutomatedAiCallTimeoutError("Choose rule", undefined),
    },
    { failure: "a dropped connection", error: new Error("fetch failed") },
    {
      failure: "a Redis error",
      error: Object.assign(new Error("ERR max requests limit exceeded"), {
        name: "UpstashError",
      }),
    },
    {
      failure: "an unreachable database",
      error: new Prisma.PrismaClientKnownRequestError("Can't reach database", {
        code: "P1001",
        clientVersion: "test",
      }),
    },
  ])("retries $failure", ({ error }) => {
    expect(isTransientMessageProcessingError(error)).toBe(true);
  });

  it.each([
    {
      failure: "a request the AI provider rejects",
      error: Object.assign(new Error("Invalid request"), { statusCode: 400 }),
    },
    {
      failure: "a unique constraint",
      error: new Prisma.PrismaClientKnownRequestError("Unique constraint", {
        code: "P2002",
        clientVersion: "test",
      }),
    },
    { failure: "a key out of credits", error: outOfCredits },
    { failure: "a low Anthropic balance", error: anthropicBalanceTooLow },
    {
      failure: "a call out of time on a key out of credits",
      error: new AutomatedAiCallTimeoutError("Choose rule", outOfCredits),
    },
    {
      failure: "a bug",
      error: new TypeError("Cannot read properties of undefined"),
    },
  ])("does not retry $failure", ({ error }) => {
    expect(isTransientMessageProcessingError(error)).toBe(false);
  });
});
