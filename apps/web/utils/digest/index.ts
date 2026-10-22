import type { Logger } from "@/utils/logger";
import type { DigestBody } from "@/app/api/ai/digest/validation";
import type { ParsedMessage } from "@/utils/types";
import type { EmailForAction } from "@/utils/ai/types";
import { enqueueBackgroundJob } from "@/utils/queue/dispatch";

const AI_DIGEST_TOPIC = "ai-digest";

export async function enqueueDigestItem({
  email,
  emailAccountId,
  actionId,
  logger,
}: {
  email: ParsedMessage | EmailForAction;
  emailAccountId: string;
  actionId?: string;
  logger: Logger;
}) {
  try {
    await enqueueBackgroundJob<DigestBody>({
      topic: AI_DIGEST_TOPIC,
      body: {
        emailAccountId,
        actionId,
        messageId: email.id,
        threadId: email.threadId,
      },
      qstash: {
        queueName: "digest-item-summarize",
        parallelism: 3,
        path: "/api/ai/digest",
      },
      logger,
    });
  } catch (error) {
    logger.error("Failed to enqueue digest item", { error });
  }
}
