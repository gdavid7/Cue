import { z } from "zod";
import { getEmailListPrompt, getTodayForLLM } from "@/utils/ai/helpers";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import { createGenerateObject } from "@/utils/llms";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";
import { parseReply } from "@/utils/mail";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { redis } from "@/utils/redis";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { GmailLabel } from "@/utils/gmail/label";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";

const MAX_MESSAGES = 6;
const MAX_MESSAGE_LENGTH = 1500;
const MAX_KEY_POINTS = 4;
const CACHE_TTL_SECONDS = 24 * 60 * 60;
// The fallback quotes sentences that ask for something or set a date. English
// only: it's a stand-in for when no model is available, not the main path.
const ASK =
  /\?|\b(please|could you|can you|would you|need|confirm|send|due|deadline|by (mon|tues|wednes|thurs|fri|satur|sun)day|today|tomorrow|friday)\b/i;

const briefSchema = z.object({
  summary: z
    .string()
    .describe(
      "One or two sentences: what this conversation needs from the user.",
    ),
  keyPoints: z
    .array(z.string())
    .describe(
      "Up to four short, specific facts or asks from the conversation.",
    ),
});

export type ThreadBrief = {
  summary: string;
  keyPoints: string[];
  /**
   * "ai" when a model wrote it. "extract" when it's the email's own sentences,
   * either because the account has no AI access or because the model failed.
   */
  source: "ai" | "extract";
  aiUnavailable?: boolean;
};

/**
 * A short summary and the key asks of a thread, cached per version of the
 * thread. Falls back to the email's own sentences without AI access, or when
 * the model fails or returns nothing.
 */
export async function getThreadBrief({
  emailAccountId,
  threadId,
  emailProvider,
  logger,
}: {
  emailAccountId: string;
  threadId: string;
  emailProvider: EmailProvider;
  logger: Logger;
}): Promise<ThreadBrief | null> {
  const thread = await emailProvider.getThread(threadId).catch((error) => {
    if (isGmailCallDeferredError(error)) throw error;
    logger.warn("Failed to load thread for brief", { error });
    return null;
  });
  // An unsent draft is the user's own words, not what the thread asks of them.
  const messages =
    thread?.messages
      .filter((message) => !message.labelIds?.includes(GmailLabel.DRAFT))
      .slice(-MAX_MESSAGES) ?? [];
  const latest = messages.at(-1);
  if (!latest) return null;

  const cacheKey = briefCacheKey({
    emailAccountId,
    threadId,
    messageId: latest.id,
  });
  const cached = await redis.get<ThreadBrief>(cacheKey).catch(() => null);
  if (cached) return cached;

  const ai = await aiBrief({ emailAccountId, messages }).catch((error) => {
    logger.warn("AI thread brief failed, using extract", { error });
    return null;
  });
  if (ai && "summary" in ai) {
    await redis.set(cacheKey, ai, { ex: CACHE_TTL_SECONDS }).catch(() => null);
    return ai;
  }
  const extract = extractBrief(messages);
  return extract && ai?.aiUnavailable
    ? { ...extract, aiUnavailable: true }
    : extract;
}

/**
 * The brief already written for a thread's latest message, without loading the
 * thread or calling a model, so reopening a conversation costs one cache read.
 */
export async function getCachedThreadBrief(key: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
}): Promise<ThreadBrief | null> {
  return redis.get<ThreadBrief>(briefCacheKey(key)).catch(() => null);
}

async function aiBrief({
  emailAccountId,
  messages,
}: {
  emailAccountId: string;
  messages: ParsedMessage[];
}): Promise<ThreadBrief | { aiUnavailable: true } | null> {
  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) return null;

  const hasAccess = await assertHasAiAccess({
    userId: emailAccount.userId,
    hasUserApiKey: !!emailAccount.user.aiApiKey,
  })
    .then(() => true)
    .catch(() => false);
  if (!hasAccess) return { aiUnavailable: true };

  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.Summarise,
  );
  const generateObject = createGenerateObject({
    emailAccount,
    label: "Thread brief",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });

  const result = await generateObject({
    ...modelOptions,
    instructions: `You brief a busy person on one email conversation before they open it.
Write a one or two sentence summary of what the conversation needs from them, then up to ${MAX_KEY_POINTS} key points: concrete asks, dates, numbers and decisions.
Use plain language. Do not invent anything that is not in the emails.`,
    prompt: `${getTodayForLLM()}

Conversation (oldest first):
${getEmailListPrompt({
  messages: messages.map((m) =>
    getEmailForLLM(m, { maxLength: MAX_MESSAGE_LENGTH, removeForwarded: true }),
  ),
  messageMaxLength: MAX_MESSAGE_LENGTH,
  maxMessages: MAX_MESSAGES,
})}`,
    schema: briefSchema,
  });

  const summary = result.object.summary.trim();
  if (!summary) return null;
  return {
    summary,
    keyPoints: result.object.keyPoints
      .map((p) => p.trim())
      .filter(Boolean)
      .slice(0, MAX_KEY_POINTS),
    source: "ai",
  };
}

/** No model: lead with the latest message's asks, in the sender's own words. */
export function extractBrief(messages: ParsedMessage[]): ThreadBrief | null {
  const latest = messages.at(-1);
  if (!latest) return null;
  const sentences = splitSentences(textOf(latest));
  const asks = sentences.filter((s) => ASK.test(s));
  const summary = (asks.length ? asks : sentences).slice(0, 2).join(" ");
  if (!summary) return null;

  const earlier = messages
    .slice(0, -1)
    .flatMap((m) => splitSentences(textOf(m)).filter((s) => ASK.test(s)));
  const keyPoints = [...asks.slice(2), ...earlier].slice(0, MAX_KEY_POINTS);
  return { summary, keyPoints, source: "extract" };
}

function textOf(m: ParsedMessage) {
  return (m.textPlain ? parseReply(m.textPlain) : m.snippet || "").trim();
}

function splitSentences(text: string) {
  return text
    .split(/(?<=[.?!])\s+|\n+/)
    .map((s) => s.trim())
    .filter(
      (s) =>
        s.length > 3 &&
        !/^(hi|hey|hello|dear|thanks|thank you|best|cheers|love|regards)\b[^.?!]*,?$/i.test(
          s,
        ),
    );
}

// Scoped to the account and keyed by the newest message: a new message gets a
// fresh brief, and one account never reads another's.
function briefCacheKey({
  emailAccountId,
  threadId,
  messageId,
}: {
  emailAccountId: string;
  threadId: string;
  messageId: string;
}) {
  return `thread-brief:${emailAccountId}:${threadId}:${messageId}`;
}
