import { type InferUITool, tool } from "ai";
import { z } from "zod";
import { createEmailProvider } from "@/utils/email/provider";
import { describeProviderRateLimitError } from "@/utils/email/rate-limit";
import type { Logger } from "@/utils/logger";
import { posthogCaptureEvent } from "@/utils/posthog";
import { searchContext } from "@/utils/thread-context/search-context";
import { searchExa } from "@/utils/exa/search";

const searchContextInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'A few distinctive words: names of people or organizations and topic words, e.g. "Nora start date" or "Citadel superday". Not a full sentence.',
    ),
  threadId: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .nullish()
    .describe(
      "Optional. The threadId of the one email thread the question is about, taken from a searchInbox or readEmail result or from the context naming the thread the user has open. With it, results also include what that email links to in the user's connected apps (Google Drive files; Jira, Asana or ClickUp tasks) and its sender's contact record in HubSpot or Salesforce. Omit it for questions that are not about a single email.",
    ),
});

export const searchContextTool = ({
  email,
  emailAccountId,
  provider,
  logger,
}: {
  email: string;
  emailAccountId: string;
  provider: string;
  logger: Logger;
}) =>
  tool({
    description: `Search the user's email, calendar, and connected apps (files in Google Drive or OneDrive, Canvas assignments, Slack messages) together, following the people involved. Finds items that match the words, plus other conversations and meetings with the people or organizations those words name, ranked by relevance. Each result says why it matched and, for app items, which app or course it came from.
Use for questions about a person, organization, or topic that may span email and calendar ("what did Nora say about the start date", "when is my Citadel interview", "what's happening with Acme"). Use searchInbox instead for exact mailbox filters such as unread, a date range, a sender address, or a label.
Results have short snippets only: call readEmail with an email result's messageId before relying on details. In the answer, say which emails or meetings it comes from, and say plainly when the results don't answer the question rather than guessing.`,
    inputSchema: searchContextInputSchema,
    execute: async ({ query, threadId }) => {
      logger.trace("Tracking tool call", { tool: "search_context", email });
      posthogCaptureEvent(email, "AI Assistant Chat Tool Call", {
        tool: "search_context",
      });

      try {
        const emailProvider = await createEmailProvider({
          emailAccountId,
          provider,
          logger,
        });
        const { results } = await searchContext({
          emailAccountId,
          userEmail: email,
          query,
          threadId: threadId ?? undefined,
          emailProvider,
          logger,
        });
        return { results, count: results.length };
      } catch (error) {
        logger.error("Failed to search context", { error });
        return {
          error:
            describeProviderRateLimitError(error, provider) ??
            "Failed to search email and calendar",
        };
      }
    },
  });

export type SearchContextTool = InferUITool<
  ReturnType<typeof searchContextTool>
>;

const searchWebInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(300)
    .describe(
      'A focused web search query using public names and topic words, e.g. "Acme Corp Series B funding" or "Next.js caching docs".',
    ),
});

export const searchWebTool = ({
  email,
  logger,
}: {
  email: string;
  logger: Logger;
}) =>
  tool({
    description: `Search the public internet. Returns up to 5 web pages, each with title, URL, publish date when known, and text excerpts.
Use for public facts that are not in the user's own data: a company or organization, what a person does publicly, news and current events, public events, product documentation, or anything the user asks you to look up online. Use searchContext or searchInbox instead for anything in the user's email, calendar, or connected apps; when a question needs both (for example, background on a company that emailed the user), use each for its part.
The query is sent to a third-party search service: never put email contents, private contact details, or other private information from the user's data in it.
In the answer, cite the URL of each page you rely on, and say plainly when the results don't answer the question rather than guessing.`,
    inputSchema: searchWebInputSchema,
    execute: async ({ query }) => {
      logger.trace("Tracking tool call", { tool: "search_web", email });
      posthogCaptureEvent(email, "AI Assistant Chat Tool Call", {
        tool: "search_web",
      });

      try {
        const results = await searchExa({ query, logger });
        return { results, count: results.length };
      } catch (error) {
        logger.error("Failed to search the web", { error });
        return { error: "Failed to search the web" };
      }
    },
  });

export type SearchWebTool = InferUITool<ReturnType<typeof searchWebTool>>;
