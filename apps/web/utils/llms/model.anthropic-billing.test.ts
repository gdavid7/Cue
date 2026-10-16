import { APICallError, generateText } from "ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isAnthropicBillingLimitError } from "@/utils/error";
import { getModel } from "./model";

vi.mock("server-only", () => ({}));
vi.mock("@/env", () => ({
  env: {
    DEFAULT_LLMS: "anthropic:claude-sonnet-5-5",
    ANTHROPIC_API_KEY: "test-anthropic-key",
  },
}));

// Anthropic's monthly spend-cap response: a 429 with no retry-after header.
const SPEND_CAP_BODY = JSON.stringify({
  type: "error",
  error: {
    type: "rate_limit_error",
    message:
      "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-11-01 at 00:00 UTC.",
    details: { error_code: "enforced_spend_limit_reached" },
  },
  request_id: "req_test",
});

describe("Anthropic billing limits", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("does not retry a spend-cap 429 that lasts until the month ends", async () => {
    fetchMock.mockImplementation(
      async () =>
        new Response(SPEND_CAP_BODY, {
          status: 429,
          headers: { "content-type": "application/json" },
        }),
    );
    const { model } = getModel({
      aiProvider: null,
      aiModel: null,
      aiApiKey: null,
    });

    const error = await generateText({ model, prompt: "hello" }).then(
      () => undefined,
      (caught: unknown) => caught,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(APICallError.isInstance(error)).toBe(true);
    expect(isAnthropicBillingLimitError(error as APICallError)).toBe(true);
  });
});
