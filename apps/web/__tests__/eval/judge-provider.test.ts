import { afterEach, describe, expect, it, vi } from "vitest";
import { getEvalJudgeUserAi } from "@/__tests__/eval/judge-provider";

describe("getEvalJudgeUserAi", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses DeepSeek V4.1 Flash through OpenRouter by default", () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "");
    vi.stubEnv("EVAL_JUDGE_MODEL", "");
    vi.stubEnv("OPENROUTER_API_KEY", "test-key");
    vi.stubEnv("ANTHROPIC_API_KEY", "");

    expect(getEvalJudgeUserAi()).toEqual({
      aiProvider: "openrouter",
      aiModel: "deepseek/deepseek-v4.1-flash",
      aiApiKey: "test-key",
    });
  });

  it("judges with Claude Haiku 5.5 on the Anthropic API without an OpenRouter key", () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "anthropic");
    vi.stubEnv("EVAL_JUDGE_MODEL", "claude-haiku-5-5");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");
    vi.stubEnv("OPENROUTER_API_KEY", "");

    expect(getEvalJudgeUserAi()).toEqual({
      aiProvider: "anthropic",
      aiModel: "claude-haiku-5-5",
      aiApiKey: "test-anthropic-key",
    });
  });

  it("falls back to Claude Sonnet 5.5 when only an Anthropic key is present", () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "");
    vi.stubEnv("EVAL_JUDGE_MODEL", "");
    vi.stubEnv("OPENROUTER_API_KEY", "");
    vi.stubEnv("ANTHROPIC_API_KEY", "test-anthropic-key");

    expect(getEvalJudgeUserAi()).toEqual({
      aiProvider: "anthropic",
      aiModel: "claude-sonnet-5-5",
      aiApiKey: "test-anthropic-key",
    });
  });

  it("allows the judge provider and model to be overridden", () => {
    vi.stubEnv("EVAL_JUDGE_PROVIDER", "google");
    vi.stubEnv("EVAL_JUDGE_MODEL", "google/test-model");
    vi.stubEnv("GOOGLE_API_KEY", "test-key");

    expect(getEvalJudgeUserAi()).toEqual({
      aiProvider: "google",
      aiModel: "google/test-model",
      aiApiKey: "test-key",
    });
  });
});
