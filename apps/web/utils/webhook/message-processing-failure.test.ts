import { describe, expect, it, vi } from "vitest";
import { Prisma } from "@/generated/prisma/client";
import { AutomatedAiCallTimeoutError } from "@/utils/llms/automated-call-bound";
import { isTransientMessageProcessingError } from "./message-processing-failure";

vi.mock("@/utils/prisma", () => ({ default: {} }));

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
    {
      failure: "a bug",
      error: new TypeError("Cannot read properties of undefined"),
    },
  ])("does not retry $failure", ({ error }) => {
    expect(isTransientMessageProcessingError(error)).toBe(false);
  });
});
