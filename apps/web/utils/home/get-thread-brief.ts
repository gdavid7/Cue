import { z } from "zod";
import { getEmailListPrompt, getTodayForLLM } from "@/utils/ai/helpers";
import type { EmailProvider } from "@/utils/email/types";
import { getEmailForLLM } from "@/utils/get-email-from-message";
import { createGenerateObject } from "@/utils/llms";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";
import { parseReply } from "@/utils/mail";
import { assertHasAiAccess } from "@/utils/premium/limits";
import { isGmailCallDeferredError } from "@/utils/gmail/quota";
import { GmailLabel } from "@/utils/gmail/label";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";

const MAX_MESSAGES = 6;
const MAX_MESSAGE_LENGTH = 1500;
const MAX_KEY_POINTS = 4;
const SLOW_STEPS_LOG_MS = 1000;
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
 * A short summary and the key asks of a thread. Falls back to the email's own
 * sentences without AI access, or when the model fails or returns nothing.
 * Never cached here: a brief is derived from the mail, so the browser keeps
 * it (RD-3).
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
  const startedAt = Date.now();
  // Who may use AI doesn't depend on the thread, so it's read while it loads.
  const writerPromise = getBriefWriter(emailAccountId);
  writerPromise.catch(() => undefined);
  const thread = await emailProvider.getThread(threadId).catch((error) => {
    if (isGmailCallDeferredError(error)) throw error;
    logger.warn("Failed to load thread for brief", { error });
    return null;
  });
  const threadMs = Date.now() - startedAt;
  // An unsent draft is the user's own words, not what the thread asks of them.
  const messages =
    thread?.messages
      .filter((message) => !message.labelIds?.includes(GmailLabel.DRAFT))
      .slice(-MAX_MESSAGES) ?? [];
  const latest = messages.at(-1);
  if (!latest) return null;

  const ai = await writerPromise
    .then((writer) => aiBrief({ writer, messages }))
    .catch((error) => {
      logger.warn("AI thread brief failed, using extract", { error });
      return null;
    });
  const totalMs = Date.now() - startedAt;
  if (totalMs >= SLOW_STEPS_LOG_MS)
    logger.info("Thread brief steps", { threadMs, totalMs });
  if (ai && "summary" in ai) return ai;
  const extract = extractBrief(messages);
  if (extract && ai?.aiUnavailable) return { ...extract, aiUnavailable: true };
  return extract;
}

/** The account that would write the brief, if it may use AI. */
async function getBriefWriter(emailAccountId: string) {
  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) return { status: "no-account" as const };
  const hasAccess = await assertHasAiAccess({
    userId: emailAccount.userId,
    hasUserApiKey: !!emailAccount.user.aiApiKey,
  })
    .then(() => true)
    .catch(() => false);
  return hasAccess
    ? { status: "ok" as const, emailAccount }
    : { status: "no-access" as const };
}

async function aiBrief({
  writer,
  messages,
}: {
  writer: Awaited<ReturnType<typeof getBriefWriter>>;
  messages: ParsedMessage[];
}): Promise<ThreadBrief | { aiUnavailable: true } | null> {
  if (writer.status === "no-account") return null;
  if (writer.status === "no-access") return { aiUnavailable: true };
  const { emailAccount } = writer;

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
