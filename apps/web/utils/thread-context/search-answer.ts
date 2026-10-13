import he from "he";
import { z } from "zod";
import { getTodayForLLM } from "@/utils/ai/helpers";
import type { EmailProvider } from "@/utils/email/types";
import { createGenerateObject } from "@/utils/llms";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";
import { assertHasAiAccess } from "@/utils/premium/limits";
import {
  type ContextSearchResult,
  searchContext,
} from "@/utils/thread-context/search-context";
import { getEmailAccountWithAi } from "@/utils/user/get";

const answerSchema = z.object({
  answer: z
    .string()
    .nullable()
    .describe(
      "One or two short sentences answering the question from the sources. Null when the search is only looking for mail, or the sources don't answer it.",
    ),
  sourceIds: z
    .array(z.string())
    .describe('The ids of the sources the answer comes from, e.g. "s1".'),
});

export type SearchAnswer = {
  answer: string;
  sources: Pick<
    ContextSearchResult,
    "id" | "kind" | "title" | "url" | "source"
  >[];
};

/**
 * Answers a committed mail search when it asks something the user's own mail,
 * calendar and apps answer. Read-only: it retrieves, then makes one model call
 * on what it found. No agent, tools or writes. Null means just show results.
 */
export async function answerSearch({
  emailAccountId,
  userEmail,
  query,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  query: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<SearchAnswer | null> {
  const { results } = await searchContext({
    emailAccountId,
    userEmail,
    query,
    emailProvider,
    logger,
    now,
  });
  if (!results.length) return null;

  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) return null;
  const hasAccess = await assertHasAiAccess({
    userId: emailAccount.userId,
    hasUserApiKey: !!emailAccount.user.aiApiKey,
  })
    .then(() => true)
    .catch(() => false);
  if (!hasAccess) return null;

  const sources = results.map((result, index) => ({
    id: `s${index + 1}`,
    result,
  }));
  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.SearchAnswer,
  );
  const generateObject = createGenerateObject({
    emailAccount,
    label: "Search answer",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });
  // A failed answer leaves the results as they are, like no answer.
  const object = await generateObject({
    ...modelOptions,
    instructions: `You answer a search the user typed into their mailbox, using only the sources: their email, calendar and connected apps.
Answer only from what the sources state, and list the ids of the sources you used.
Return a null answer when the search is just looking for mail (a name, a topic, a sender) rather than asking a question, or when the sources don't answer it. Never guess.
Answer in one or two short sentences, in the language of the question.`,
    prompt: `${getTodayForLLM(now)}

<sources>
${sources.map(({ id, result }) => renderResult(id, result)).join("\n")}
</sources>

<question>${he.escape(query)}</question>`,
    schema: answerSchema,
  })
    .then((result) => result.object)
    .catch((error) => {
      logger.warn("Search answer failed", { error });
      return null;
    });
  if (!object) return null;

  const answer = object.answer?.trim();
  if (!answer) return null;
  const byId = new Map(sources.map(({ id, result }) => [id, result]));
  const cited = [...new Set(object.sourceIds.map((id) => id.trim()))].flatMap(
    (id) => {
      const result = byId.get(id);
      return result
        ? [
            {
              id: result.id,
              kind: result.kind,
              title: result.title,
              url: result.url,
              source: result.source,
            },
          ]
        : [];
    },
  );
  // An answer that names no source the user can check isn't shown.
  if (!cited.length) return null;
  return { answer, sources: cited };
}

function renderResult(id: string, result: ContextSearchResult) {
  return `<source id="${id}" kind="${result.kind}">
${he.escape(`${result.title}${result.source ? ` (${result.source})` : ""} · ${result.at}`)}
${he.escape(result.snippet)}
</source>`;
}
