import he from "he";
import { z } from "zod";
import type { EmailProvider } from "@/utils/email/types";
import { createGenerateObject } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";
import {
  cleanGeneratedSearch,
  MAX_GENERATED_SEARCHES,
} from "@/utils/mail-search/natural-language-search";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { getEmailAccountWithAi } from "@/utils/user/get";

/**
 * The model call gets this long; past it the search shows its plain results
 * only. Leaves room in the AI path's ~4 s budget for the searches to run.
 */
export const INTERPRET_SEARCH_TIMEOUT_MS = 3000;

const searchIntentSchema = z.object({
  searches: z
    .array(z.string())
    .describe(
      "1 to 3 mailbox searches, most likely first, in Gmail search syntax: from:, to:, subject:, label:, has:attachment, is:unread, is:starred, in:sent, after:YYYY/MM/DD, before:YYYY/MM/DD (exclusive) and plain words. Every word must match, so join alternatives and synonyms with OR (lease OR contract). Put a person's name in from: or to: as written (from:sarah). Resolve relative dates against today.",
    ),
  explanation: z
    .string()
    .describe(
      'How you read the search, as one short line in the language of the search, e.g. "Mail from Sarah with attachments in September mentioning lease or contract".',
    ),
  isQuestion: z
    .boolean()
    .describe(
      "True when the search asks something the mail could answer (when is my flight?), false when it only looks for mail.",
    ),
});

export type SearchIntent = {
  /** Cleaned searches in the account provider's syntax; may be empty. */
  searches: string[];
  explanation: string;
  isQuestion: boolean;
};

/**
 * Reads a search typed as a sentence and turns it into searches Cue runs on
 * the local mail first, with the provider as fallback. One model call, on the
 * typed text alone: no mail is sent to the model. Null means show the plain
 * results only.
 */
export async function interpretSearch({
  emailAccountId,
  query,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  query: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<SearchIntent | null> {
  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) return null;
  const hasAccess = await assertHasAiAccess({
    userId: emailAccount.userId,
    hasUserApiKey: !!emailAccount.user.aiApiKey,
  })
    .then(() => true)
    .catch(() => false);
  if (!hasAccess) return null;

  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(new Error("Search interpretation timed out")),
    INTERPRET_SEARCH_TIMEOUT_MS,
  );
  // Both settle at the deadline even if a call ignores the abort.
  const [intent, labelNames] = await Promise.all([
    Promise.race([
      aiInterpretSearch({
        emailAccount,
        query,
        now,
        abortSignal: timeout.signal,
      }),
      rejectOnAbort(timeout.signal),
    ]).catch((error) => {
      logger.warn("Search interpretation failed", {
        error,
        timedOut: timeout.signal.aborted,
      });
      return null;
    }),
    // A label the account doesn't have would make a search find nothing.
    Promise.race([
      emailProvider
        .getLabels()
        .then((labels) => labels.map((label) => label.name)),
      rejectOnAbort(timeout.signal),
    ]).catch((error) => {
      logger.warn("Failed to load labels for search interpretation", {
        error,
      });
      return [] as string[];
    }),
  ]).finally(() => clearTimeout(timer));
  if (!intent) return null;

  return {
    searches: cleanGeneratedSearches(intent.searches, {
      now,
      provider: emailProvider.name,
      labelNames,
    }),
    explanation: intent.explanation.trim(),
    isQuestion: intent.isQuestion,
  };
}

export async function aiInterpretSearch({
  emailAccount,
  query,
  now,
  abortSignal,
}: {
  emailAccount: EmailAccountWithAI;
  query: string;
  now: Date;
  abortSignal?: AbortSignal;
}) {
  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.SearchIntent,
  );
  const generateObject = createGenerateObject({
    emailAccount,
    label: "Search intent",
    modelOptions,
    promptHardening: { trust: "trusted" },
  });
  const result = await generateObject({
    ...modelOptions,
    abortSignal,
    instructions: SEARCH_INTENT_INSTRUCTIONS,
    prompt: buildSearchIntentPrompt({
      query,
      now,
      timezone: emailAccount.timezone,
    }),
    schema: searchIntentSchema,
  });
  return result.object;
}

export const SEARCH_INTENT_INSTRUCTIONS = `You turn what the user typed into their mailbox search bar into searches that find the mail they mean.
Put people, dates, attachments and labels into operators, and keep only the words the mail itself would contain, with close synonyms.
Use label: only for a label the user names. Never add a sender, date or detail the search doesn't state.`;

export function buildSearchIntentPrompt({
  query,
  now,
  timezone,
}: {
  query: string;
  now: Date;
  timezone: string | null;
}) {
  const today = now.toLocaleDateString("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone || "UTC",
  });
  return `Today is ${today}.

<search>${he.escape(query)}</search>`;
}

/** Cleans each generated search and drops repeats and the unusable. */
export function cleanGeneratedSearches(
  searches: string[],
  context: Parameters<typeof cleanGeneratedSearch>[1],
): string[] {
  const cleaned = searches.flatMap((search) => {
    const result = cleanGeneratedSearch(search, context);
    return result ? [result] : [];
  });
  return [...new Set(cleaned)].slice(0, MAX_GENERATED_SEARCHES);
}

function rejectOnAbort(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
