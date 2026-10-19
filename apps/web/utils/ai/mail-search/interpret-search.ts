import he from "he";
import type { EmailProvider } from "@/utils/email/types";
import { createGenerateObject } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";
import {
  buildGeneratedSearch,
  readableSearch,
  type SearchIntentParts,
  searchIntentSchema,
} from "@/utils/mail-search/generated-search";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { getEmailAccountWithAi } from "@/utils/user/get";

/**
 * The model call gets this long; past it the search shows its plain results
 * only. Leaves room in the AI path's ~4 s budget for the searches to run.
 */
export const INTERPRET_SEARCH_TIMEOUT_MS = 3000;

export type SearchIntent = {
  /** Searches in the account provider's syntax; may be empty. */
  searches: string[];
  /** The same searches with dates a person can read, to edit one. */
  editableSearches: string[];
  /**
   * Only unread mail, which Cue applies to its local mail itself: Outlook's
   * search can't filter on it, so it isn't in the search.
   */
  unreadOnly: boolean;
  explanation: string;
  isQuestion: boolean;
  /** The account's time zone, which dates in the searches are read in. */
  timeZone: string;
};

/**
 * Reads a search typed as a sentence and turns it into a search Cue runs on
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
  const [parts, labelNames] = await Promise.all([
    Promise.race([
      aiInterpretSearch({
        emailAccount,
        query,
        now,
        abortSignal: timeout.signal,
      }),
      rejectOnAbort(timeout.signal),
    ]).catch((error) => {
      // A parse or validation error's message can quote the model's output.
      logger.warn("Search interpretation failed", {
        timedOut: timeout.signal.aborted,
        errorName: errorName(error),
      });
      logger.trace("Search interpretation error", { error });
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
        timedOut: timeout.signal.aborted,
        errorName: errorName(error),
      });
      logger.trace("Label load error", { error });
      return [] as string[];
    }),
  ]).finally(() => clearTimeout(timer));
  if (!parts) return null;

  return toSearchIntent(parts, {
    now,
    timeZone: accountTimeZone(emailAccount.timezone),
    provider: emailProvider.name,
    labelNames,
  });
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
}): Promise<SearchIntentParts> {
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
      timeZone: accountTimeZone(emailAccount.timezone),
    }),
    schema: searchIntentSchema,
  });
  return result.object;
}

export const SEARCH_INTENT_INSTRUCTIONS = `You read what the user typed into their mailbox search bar and name the parts of the mail they mean, which Cue turns into a search.
Fill only what the user states or clearly implies, and leave everything else empty: an added sender, date or condition hides the mail they want.
Write the explanation in the language the user typed in.`;

export function buildSearchIntentPrompt({
  query,
  now,
  timeZone,
}: {
  query: string;
  now: Date;
  timeZone: string;
}) {
  const today = now.toLocaleDateString("en-CA", {
    weekday: "long",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone,
  });
  return `Today is ${today}.

<search>${he.escape(query)}</search>`;
}

/** The search Cue runs for a model's reading, and how to show it. */
export function toSearchIntent(
  parts: SearchIntentParts,
  context: Parameters<typeof buildGeneratedSearch>[1],
): SearchIntent {
  const search = buildGeneratedSearch(parts, context);
  const searches = search ? [search] : [];
  return {
    searches,
    editableSearches: searches.map((s) => readableSearch(s, context.timeZone)),
    unreadOnly: parts.unread && context.provider === "microsoft",
    explanation: parts.explanation.trim(),
    isQuestion: parts.isQuestion,
    timeZone: context.timeZone,
  };
}

/** The account's time zone when it names a real one, else UTC. */
export function accountTimeZone(timeZone: string | null | undefined) {
  if (!timeZone) return "UTC";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone });
    return timeZone;
  } catch {
    return "UTC";
  }
}

function errorName(error: unknown) {
  return error instanceof Error ? error.name : typeof error;
}

function rejectOnAbort(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    signal.addEventListener("abort", () => reject(signal.reason), {
      once: true,
    });
  });
}
