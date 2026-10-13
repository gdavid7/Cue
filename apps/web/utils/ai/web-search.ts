import {
  isStepCount,
  type PrepareStepFunction,
  type StopCondition,
  type ToolSet,
  tool,
} from "ai";
import { google } from "@ai-sdk/google";
import { openai } from "@ai-sdk/openai";
import { openrouter } from "@openrouter/ai-sdk-provider";
import { z } from "zod";
import { Provider } from "@/utils/llms/config";
import { isExaSearchEnabled, searchExa } from "@/utils/exa/search";
import { createScopedLogger } from "@/utils/logger";

// Exa runs as a client-side tool, so the model needs extra steps to read the
// results; the final step disables tools so it has to answer.
const EXA_MAX_SEARCH_STEPS = 2;

export type WebSearchConfig = {
  providerName: string;
  tools: ToolSet;
  providerOptions?: Record<string, Record<string, number>>;
  toolChoice?: "required";
  stopWhen?: StopCondition<ToolSet>;
  prepareStep?: PrepareStepFunction<ToolSet>;
};

export function getWebSearchConfigForProvider(
  provider: string | undefined,
): WebSearchConfig | null {
  if (isExaSearchEnabled()) {
    return {
      providerName: "Exa",
      tools: { web_search: createExaWebSearchTool() },
      stopWhen: isStepCount(EXA_MAX_SEARCH_STEPS + 1),
      prepareStep: ({ stepNumber }) =>
        stepNumber >= EXA_MAX_SEARCH_STEPS ? { toolChoice: "none" } : {},
    };
  }

  switch (provider) {
    case Provider.OPEN_AI:
      return {
        providerName: "OpenAI",
        tools: { web_search: openai.tools.webSearch({}) },
      };
    case Provider.GOOGLE:
      return {
        providerName: "Google",
        tools: { google_search: google.tools.googleSearch({}) },
      };
    case Provider.OPENROUTER:
      return {
        providerName: "OpenRouter",
        tools: {
          web_search: openrouter.tools.webSearch({
            engine: "auto",
            maxResults: 5,
          }),
        },
        providerOptions: { openrouter: { max_tool_calls: 1 } },
        toolChoice: "required",
      };
    default:
      return null;
  }
}

function createExaWebSearchTool() {
  const logger = createScopedLogger("ai/web-search");

  return tool({
    description:
      "Search the public web. Returns matching pages with title, URL, publish date when known, and text excerpts. Cite the URLs of pages you rely on.",
    inputSchema: z.object({
      query: z
        .string()
        .trim()
        .min(1)
        .max(300)
        .describe(
          'A focused web search query, e.g. a full name with company or role such as "Jane Doe Acme head of sales".',
        ),
    }),
    execute: async ({ query }) => {
      try {
        const results = await searchExa({ query, logger });
        return { results };
      } catch (error) {
        logger.error("Exa web search failed", { error });
        return { error: "Web search failed" };
      }
    },
  });
}
