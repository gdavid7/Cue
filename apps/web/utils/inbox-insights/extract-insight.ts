import he from "he";
import { z } from "zod";
import { createGenerateObject } from "@/utils/llms";
import type { EmailAccountWithAI } from "@/utils/llms/types";
import { getModelForUseCase, LlmUseCase } from "@/utils/llms/use-cases";
import { parseReply } from "@/utils/mail";
import type { ParsedMessage } from "@/utils/types";

const MAX_BODY_LENGTH = 2500;
const MAX_TASK_WORDS = 10;

const insightSchema = z.object({
  action: z
    .enum(["reply", "do", "none"])
    .describe(
      '"reply" if the sender is waiting for the user to write back, "do" if the email asks the user to do something else (pay, sign, submit, register, RSVP, book), "none" otherwise. Most newsletters, promotions, receipts and notifications are "none".',
    ),
  task: z
    .string()
    .describe(
      'For reply or do: what the user needs to do, as a short imperative phrase of at most 8 words, e.g. "Share availability for 2 interviews". Empty for none.',
    ),
  date: z
    .string()
    .describe(
      "The one date that matters most in the email, if it states one: when the action is due, when an offer expires, or when an event happens. ISO 8601: YYYY-MM-DD, or YYYY-MM-DDTHH:mm with the UTC offset when a time is given. Resolve relative dates from today's date. Empty if the email states no date.",
    ),
  dateRole: z
    .enum(["deadline", "expires", "event", "none"])
    .describe(
      'What the date is: "deadline" for when the action is due, "expires" for when an offer or link stops working, "event" for when something happens. "none" when date is empty.',
    ),
  fact: z
    .string()
    .describe(
      "One detail the user may need later without opening the email, copied exactly from the email: a confirmation or tracking code, an amount, a time, a place. Empty if there is none worth keeping.",
    ),
  factLabel: z
    .string()
    .describe(
      'One or two words naming the fact, e.g. "Confirmation", "Total", "Room". Empty when fact is empty.',
    ),
});

export type EmailInsight = {
  action: "reply" | "do" | "none";
  task: string;
  date: string | null;
  dateRole: "deadline" | "expires" | "event" | null;
  fact: string | null;
  factLabel: string | null;
};

/**
 * What one email asks of the user and the detail they'd want at a glance, for
 * the line under its row in the inbox. Most emails get nothing: an empty
 * insight is the expected answer, so the line only shows when it matters.
 */
export async function aiExtractInsight({
  emailAccount,
  message,
  timezone,
  now = new Date(),
}: {
  emailAccount: EmailAccountWithAI;
  message: ParsedMessage;
  timezone: string | null;
  now?: Date;
}): Promise<EmailInsight> {
  const modelOptions = getModelForUseCase(
    emailAccount.user,
    LlmUseCase.InboxInsight,
  );
  const generateObject = createGenerateObject({
    emailAccount,
    label: "Inbox insight",
    modelOptions,
    promptHardening: { trust: "untrusted", level: "compact" },
  });

  const body = bodyOf(message);
  const result = await generateObject({
    ...modelOptions,
    instructions: `You add a one-line note under an email in the user's inbox, so they can tell at a glance what it asks of them.
Only fill a field when it changes what the user would do. When the email asks nothing and holds no detail worth keeping, return action "none" and empty fields.
Never infer a request, a date or a detail the email doesn't state.`,
    prompt: `Today is ${formatToday(now, timezone)} (time zone ${timezone || "UTC"}).

<email>
Subject: ${he.escape(message.headers.subject || "")}
From: ${he.escape(message.headers.from || "")}

${he.escape(body)}
</email>`,
    schema: insightSchema,
  });

  return checkInsight(result.object, `${message.headers.subject}\n${body}`);
}

/**
 * Drops what the model couldn't have read in the email: a fact that isn't in
 * it word for word, or a date that doesn't parse. A wrong confirmation code
 * shown as if it were the email's is worse than none.
 */
export function checkInsight(
  output: z.infer<typeof insightSchema>,
  emailText: string,
): EmailInsight {
  const fact = output.fact.trim();
  const factFound =
    fact.length > 0 && normalize(emailText).includes(normalize(fact));
  const date = output.date.trim();
  const dateValid =
    date.length > 0 &&
    output.dateRole !== "none" &&
    !Number.isNaN(Date.parse(date));
  const task =
    output.action === "none"
      ? ""
      : output.task.trim().split(/\s+/).slice(0, MAX_TASK_WORDS).join(" ");

  return {
    action: output.action,
    task,
    date: dateValid ? date : null,
    dateRole: dateValid && output.dateRole !== "none" ? output.dateRole : null,
    fact: factFound ? fact : null,
    factLabel: factFound ? output.factLabel.trim() || null : null,
  };
}

function bodyOf(message: ParsedMessage) {
  return (
    message.textPlain ? parseReply(message.textPlain) : message.snippet || ""
  )
    .trim()
    .slice(0, MAX_BODY_LENGTH);
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

function formatToday(now: Date, timezone: string | null) {
  return now.toLocaleDateString("en-US", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    timeZone: timezone || "UTC",
  });
}
