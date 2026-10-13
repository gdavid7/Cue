import { type InferUITool, tool } from "ai";
import { z } from "zod";
import { createEmailProvider } from "@/utils/email/provider";
import type { Logger } from "@/utils/logger";
import { posthogCaptureEvent } from "@/utils/posthog";
import { searchContext } from "@/utils/thread-context/search-context";

const searchContextInputSchema = z.object({
  query: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe(
      'A few distinctive words: names of people or organizations and topic words, e.g. "Nora start date" or "Citadel superday". Not a full sentence.',
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
    description: `Search the user's email and calendar together, following the people involved. Finds conversations and meetings that match the words, plus other conversations and meetings with the people or organizations those words name, ranked by relevance. Each result says why it matched.
Use for questions about a person, organization, or topic that may span email and calendar ("what did Nora say about the start date", "when is my Citadel interview", "what's happening with Acme"). Use searchInbox instead for exact mailbox filters such as unread, a date range, a sender address, or a label.
Results have short snippets only: call readEmail with an email result's messageId before relying on details. In the answer, say which emails or meetings it comes from, and say plainly when the results don't answer the question rather than guessing.`,
    inputSchema: searchContextInputSchema,
    execute: async ({ query }) => {
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
          emailProvider,
          logger,
        });
        return { results, count: results.length };
      } catch (error) {
        logger.error("Failed to search context", { error });
        return { error: "Failed to search email and calendar" };
      }
    },
  });

export type SearchContextTool = InferUITool<
  ReturnType<typeof searchContextTool>
>;
