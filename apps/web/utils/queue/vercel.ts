import vercelConfig from "@/vercel.json";

// Only topics with a queue trigger in vercel.json have a consumer deployed on
// Vercel; messages sent to any other topic are never processed.
const deployedVercelQueueTopics = new Set(
  Object.values(
    vercelConfig.functions as Record<
      string,
      { experimentalTriggers?: { type?: string; topic?: string }[] }
    >,
  ).flatMap((config) =>
    (config.experimentalTriggers ?? []).flatMap((trigger) =>
      trigger.type?.startsWith("queue/") && trigger.topic
        ? [trigger.topic]
        : [],
    ),
  ),
);

export function isVercelQueueDispatchEnabled() {
  return process.env.VERCEL === "1";
}

export function hasDeployedVercelQueueConsumer(topic: string) {
  return deployedVercelQueueTopics.has(topic);
}
