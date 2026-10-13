import he from "he";
import { z } from "zod";
import { getTodayForLLM, getWritingStylePrompt } from "@/utils/ai/helpers";
import { isSameEmailAddress } from "@/utils/email";
import { getMessageTimestamp } from "@/utils/email/message-timestamp";
import type { EmailProvider } from "@/utils/email/types";
import { createGenerateObject } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import type { Logger } from "@/utils/logger";
import { parseReply } from "@/utils/mail";
import { assertHasAiAccess } from "@/utils/premium/limits";
import prisma from "@/utils/prisma";
import { redis } from "@/utils/redis";
import { collectThreadContext } from "@/utils/thread-context/get-thread-context";
import type { ParsedMessage } from "@/utils/types";
import { getEmailAccountWithAi } from "@/utils/user/get";

const MAX_THREAD_MESSAGES = 6;
const MAX_SOURCE_TEXT = 2000;
const MAX_CONTEXT_SOURCES = 4;
const CACHE_TTL_SECONDS = 24 * 60 * 60;

const suggestionSchema = z.object({
  enoughEvidence: z
    .boolean()
    .describe(
      "True only if every fact, number, date, decision or commitment the reply needs is stated in the sources. False if a good reply would need something no source states.",
    ),
  missing: z
    .string()
    .describe(
      "When enoughEvidence is false: what information is missing, as one short sentence the user can act on. Empty otherwise.",
    ),
  reply: z
    .string()
    .describe(
      "When enoughEvidence is true: the reply body in the user's voice, plain text, without a subject line or signature. Empty otherwise.",
    ),
  claims: z
    .array(
      z.object({
        fact: z.string().describe("A fact the reply states or relies on."),
        sourceId: z
          .string()
          .describe('The id of the source that states it, e.g. "m2" or "c1".'),
        quote: z
          .string()
          .describe(
            "The words in that source that state it, copied exactly, at most 30 words.",
          ),
      }),
    )
    .describe(
      "Every fact the reply states or relies on, each with its source. Empty only if the reply states no facts.",
    ),
});

export type Source = {
  id: string;
  kind: "message" | "email" | "event";
  title: string;
  text: string;
  /** For related emails, so the user can open them. */
  threadId?: string;
  url?: string;
};

export type Citation = {
  fact: string;
  quote: string;
  source: Omit<Source, "text">;
};

export type SuggestedReply =
  | { status: "suggested"; reply: string; citations: Citation[] }
  /** The model said it lacked a fact, or cited one it couldn't back up. */
  | { status: "insufficient"; missing: string; unsupported: string[] }
  | { status: "already-replied" }
  | { status: "unavailable" };

/**
 * A reply suggested only when the conversation and its related context back
 * every fact in it. The model cites a source and quotes it for each fact, and
 * the quotes are checked against the sources here, so a reply built on a fact
 * nobody wrote down is never shown. Abstaining is a normal answer.
 */
export async function suggestReply({
  emailAccountId,
  userEmail,
  threadId,
  emailProvider,
  logger,
  now = new Date(),
}: {
  emailAccountId: string;
  userEmail: string;
  threadId: string;
  emailProvider: EmailProvider;
  logger: Logger;
  now?: Date;
}): Promise<SuggestedReply | null> {
  const { thread, items } = await collectThreadContext({
    emailAccountId,
    userEmail,
    threadId,
    emailProvider,
    logger,
    now,
  });
  const latest = thread?.messages.at(-1);
  if (!thread || !latest) return null;
  if (isSameEmailAddress(latest.headers.from, userEmail)) {
    return { status: "already-replied" };
  }

  // A new message changes the key, so a cached suggestion is never stale.
  const cacheKey = `suggested-reply:${emailAccountId}:${threadId}:${latest.id}`;
  const cached = await redis.get<SuggestedReply>(cacheKey).catch(() => null);
  if (cached) return cached;

  const emailAccount = await getEmailAccountWithAi({ emailAccountId });
  if (!emailAccount) return null;
  const hasAccess = await assertHasAiAccess({
    userId: emailAccount.userId,
    hasUserApiKey: !!emailAccount.user.aiApiKey,
  })
    .then(() => true)
    .catch(() => false);
  if (!hasAccess) return { status: "unavailable" };

  const sources = [
    ...thread.messages
      .slice(-MAX_THREAD_MESSAGES)
      .map((m, i) => messageSource(m, i, emailAccount.timezone)),
    ...(await contextSources({
      items: items.slice(0, MAX_CONTEXT_SOURCES),
      emailProvider,
      timezone: emailAccount.timezone,
      logger,
    })),
  ];

  const { writingStyle } =
    (await prisma.emailAccount.findUnique({
      where: { id: emailAccountId },
      select: { writingStyle: true },
    })) ?? {};

  const suggestion = await aiSuggestReply({
    emailAccount,
    sources,
    writingStyle,
    now,
  });
  await redis
    .set(cacheKey, suggestion, { ex: CACHE_TTL_SECONDS })
    .catch(() => null);
  return suggestion;
}

/** The model call on sources already gathered, so evals can feed it fixed ones. */
export async function aiSuggestReply({
  emailAccount,
  sources,
  writingStyle,
  now = new Date(),
}: {
  emailAccount: EmailAccountWithAI & { name: string | null };
  sources: Source[];
  writingStyle?: string | null;
  now?: Date;
}): Promise<SuggestedReply> {
  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.DraftReply,
  );
  const generateObject = createGenerateObject({
    emailAccount,
    label: "Grounded reply suggestion",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });

  const result = await generateObject({
    ...modelOptions,
    instructions: `You suggest a reply to the latest message in an email conversation, on behalf of ${emailAccount.name || emailAccount.email}.
The sources are the conversation's messages (m1, m2, ...) and related emails and meetings from the user's account (c1, c2, ...).
Suggest a reply only if the sources state every fact the reply needs. A reply that commits the user to something, gives a number, date, price, time or decision, or answers a question needs a source that states it. Never fill a gap with a plausible guess.
If the sources don't settle what the user should say, set enoughEvidence to false and say what is missing instead.
For each fact in the reply, cite the source and copy the exact words that state it.
Keep the reply short and in the user's voice.
${getWritingStylePrompt(writingStyle)}`,
    prompt: `${getTodayForLLM(now)}

<sources>
${sources.map(renderSource).join("\n")}
</sources>

Suggest a reply to the latest message, ${sources.filter((s) => s.kind === "message").at(-1)?.id}.`,
    schema: suggestionSchema,
  });

  return checkSuggestion(result.object, sources);
}

/**
 * Keeps the model honest: every cited quote must appear in the source it
 * names. One fact that can't be found is enough to withhold the reply.
 */
export function checkSuggestion(
  output: z.infer<typeof suggestionSchema>,
  sources: Source[],
): SuggestedReply {
  const byId = new Map(sources.map((s) => [s.id, s]));
  const reply = output.reply.trim();
  if (!output.enoughEvidence || !reply) {
    return {
      status: "insufficient",
      missing: output.missing.trim(),
      unsupported: [],
    };
  }

  const citations: Citation[] = [];
  const unsupported: string[] = [];
  for (const claim of output.claims) {
    const source = byId.get(claim.sourceId.trim());
    const quote = claim.quote.trim();
    if (source && quote && containsQuote(source.text, quote)) {
      const { text: _text, ...meta } = source;
      citations.push({ fact: claim.fact.trim(), quote, source: meta });
    } else {
      unsupported.push(claim.fact.trim());
    }
  }

  if (unsupported.length) {
    return { status: "insufficient", missing: "", unsupported };
  }
  return { status: "suggested", reply, citations };
}

function containsQuote(text: string, quote: string) {
  const needle = normalize(he.decode(quote))
    // Models trim quotes with ellipses or wrap them in quote marks.
    .replace(/^["'…. ]+|["'…. ]+$/g, "");
  return needle.length > 0 && normalize(text).includes(needle);
}

function normalize(text: string) {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

async function contextSources({
  items,
  emailProvider,
  timezone,
  logger,
}: {
  items: Awaited<ReturnType<typeof collectThreadContext>>["items"];
  emailProvider: EmailProvider;
  timezone: string | null;
  logger: Logger;
}): Promise<Source[]> {
  // Ranking ran on headers and snippets; the reply needs what was actually said.
  return Promise.all(
    items.map(async (item, i) => {
      const id = `c${i + 1}`;
      if (item.kind === "event") {
        return {
          id,
          kind: "event" as const,
          title: item.title,
          text: `Meeting: ${item.title}\nWhen: ${formatTime(item.at, timezone)}\n${item.text}`,
          url: item.url,
        };
      }
      const full = await emailProvider.getThread(item.id).catch((error) => {
        logger.warn("Failed to load related thread", { error });
        return null;
      });
      return {
        id,
        kind: "email" as const,
        title: item.title,
        text: full?.messages.length
          ? full.messages
              .slice(-3)
              .map((m) => messageText(m, timezone))
              .join("\n\n")
          : item.text,
        threadId: item.id,
      };
    }),
  );
}

function messageSource(
  m: ParsedMessage,
  index: number,
  timezone: string | null,
): Source {
  return {
    id: `m${index + 1}`,
    kind: "message",
    title: `${m.headers.from}, ${formatTime(new Date(getMessageTimestamp(m)).toISOString(), timezone)}`,
    text: messageText(m, timezone),
  };
}

function messageText(m: ParsedMessage, timezone: string | null) {
  const body = (m.textPlain ? parseReply(m.textPlain) : m.snippet || "")
    .trim()
    .slice(0, MAX_SOURCE_TEXT);
  return `Subject: ${m.headers.subject}
From: ${m.headers.from}
Date: ${formatTime(new Date(getMessageTimestamp(m)).toISOString(), timezone)}

${body}`;
}

function renderSource(source: Source) {
  return `<source id="${source.id}" kind="${source.kind}">
${he.escape(source.text)}
</source>`;
}

function formatTime(iso: string, timezone: string | null) {
  return new Date(iso).toLocaleString("en-US", {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone || "UTC",
  });
}
