import { beforeEach, describe, expect, it, vi } from "vitest";
import { getWebSearchConfigForProvider } from "@/utils/ai/web-search";

const { mockEnv, searchExaMock } = vi.hoisted(() => ({
  mockEnv: { EXA_API_KEY: undefined as string | undefined },
  searchExaMock: vi.fn(),
}));

vi.mock("@/env", () => ({ env: mockEnv }));

vi.mock("@/utils/exa/search", () => ({
  isExaSearchEnabled: () => Boolean(mockEnv.EXA_API_KEY),
  searchExa: searchExaMock,
}));

describe("getWebSearchConfigForProvider", () => {
  beforeEach(() => {
    mockEnv.EXA_API_KEY = undefined;
    searchExaMock.mockReset();
  });

  it("keeps provider built-in search when Exa is not configured", () => {
    expect(getWebSearchConfigForProvider("openai")?.providerName).toBe(
      "OpenAI",
    );
    expect(getWebSearchConfigForProvider("anthropic")).toBeNull();
  });

  it("prefers Exa for every provider when the key is set", () => {
    mockEnv.EXA_API_KEY = "test-exa-key";

    for (const provider of ["anthropic", "openai", "openrouter", undefined]) {
      const config = getWebSearchConfigForProvider(provider);
      expect(config?.providerName).toBe("Exa");
      expect(config?.tools).toHaveProperty("web_search");
      expect(config?.toolChoice).toBeUndefined();
      expect(config?.providerOptions).toBeUndefined();
    }
  });

  it("lets the model search and then forces a final answer", async () => {
    mockEnv.EXA_API_KEY = "test-exa-key";
    const config = getWebSearchConfigForProvider("anthropic");
    const prepareStep = config?.prepareStep;
    const stopWhen = config?.stopWhen;
    if (!prepareStep || !stopWhen) throw new Error("Expected step controls");

    const stepOptions = (stepNumber: number) =>
      ({ stepNumber }) as Parameters<typeof prepareStep>[0];
    expect(await prepareStep(stepOptions(0))).not.toHaveProperty("toolChoice");
    expect(await prepareStep(stepOptions(2))).toEqual({ toolChoice: "none" });

    const stopAfter = (count: number) =>
      stopWhen({ steps: Array.from({ length: count }) } as Parameters<
        typeof stopWhen
      >[0]);
    expect(await stopAfter(2)).toBe(false);
    expect(await stopAfter(3)).toBe(true);
  });

  it("returns Exa results from the tool and reports failures without throwing", async () => {
    mockEnv.EXA_API_KEY = "test-exa-key";
    const searchTool =
      getWebSearchConfigForProvider("anthropic")?.tools.web_search;
    const execute = searchTool?.execute;
    if (!execute) throw new Error("Expected an executable tool");
    const options = {
      toolCallId: "call-1",
      messages: [],
    } as unknown as Parameters<typeof execute>[1];

    const results = [{ title: "Acme", url: "https://acme.example.com" }];
    searchExaMock.mockResolvedValueOnce(results);
    await expect(execute({ query: "Acme" }, options)).resolves.toEqual({
      results,
    });

    searchExaMock.mockRejectedValueOnce(new Error("timeout"));
    await expect(execute({ query: "Acme" }, options)).resolves.toEqual({
      error: "Web search failed",
    });
  });
});
