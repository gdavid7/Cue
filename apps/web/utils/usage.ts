/** biome-ignore-all lint/style/noMagicNumbers: we're defining constants */
import type { LanguageModelUsage } from "ai";
import { saveUsage } from "@/utils/redis/usage";
import { OPENROUTER_MODEL_PRICING } from "@/utils/llms/pricing.generated";
import {
  STATIC_MODEL_PRICING,
  type ModelPricing,
} from "@/utils/llms/supported-model-pricing";
import {
  getOpenRouterProviderPrefix,
  stripOnlineModelSuffix,
} from "@/utils/llms/model-id";
import { publishAiCall } from "@inboxzero/tinybird-ai-analytics";
import { createScopedLogger } from "@/utils/logger";

const logger = createScopedLogger("usage");

export type AiUsageEvent = {
  cachedInputTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  inputTokens: number;
  label: string;
  model: string;
  outputTokens: number;
  platformCost: number;
  provider: string;
  providerCostSource?: string;
  providerReportedCost?: number;
  providerUpstreamInferenceCost?: number;
  reasoningTokens: number;
  totalTokens: number;
};

export type ModelFallbackRecord = {
  fromProvider: string;
  fromModel: string;
  toProvider: string;
  toModel: string;
  reason: string;
};

type AiUsageListener = (event: AiUsageEvent) => void;

const aiUsageListeners = new Set<AiUsageListener>();

export function subscribeToAiUsage(listener: AiUsageListener): () => void {
  aiUsageListeners.add(listener);
  return () => {
    aiUsageListeners.delete(listener);
  };
}

export async function saveAiUsage({
  userId,
  email,
  emailAccountId,
  provider,
  model,
  usage,
  stepUsages,
  label,
  hasUserApiKey,
  providerReportedCost,
  providerUpstreamInferenceCost,
  providerCostSource,
  providerRequestIds,
  stepCount,
  toolCallCount,
  modelFallbacks,
  usageIncomplete,
}: {
  userId?: string;
  email: string;
  emailAccountId: string;
  provider: string;
  model: string;
  usage: LanguageModelUsage;
  // Per-request usage of a multi-step run, for prompt-size-dependent rates.
  stepUsages?: LanguageModelUsage[];
  label: string;
  hasUserApiKey?: boolean;
  providerReportedCost?: number;
  providerUpstreamInferenceCost?: number;
  providerCostSource?: string;
  providerRequestIds?: string[];
  stepCount?: number;
  toolCallCount?: number;
  // Models the run switched away from mid-run; its usage is all recorded
  // under the model it finished on.
  modelFallbacks?: ModelFallbackRecord[];
  // A call that failed after streaming output reports no usage, so the totals
  // undercount it.
  usageIncomplete?: boolean;
}) {
  const estimatedCost = calculateUsageCost({
    provider,
    model,
    usage,
    stepUsages,
  });
  const isUserApiKey = !!hasUserApiKey;
  const platformCost = isUserApiKey
    ? 0
    : getPlatformCost({
        estimatedCost,
        providerReportedCost,
        providerUpstreamInferenceCost,
      });
  const inputTokens = usage.inputTokens ?? 0;
  const outputTokens = usage.outputTokens ?? 0;
  const cachedInputTokens = usage.inputTokenDetails?.cacheReadTokens ?? 0;
  const cacheWriteTokens = usage.inputTokenDetails?.cacheWriteTokens ?? 0;
  const reasoningTokens = usage.outputTokenDetails?.reasoningTokens ?? 0;
  const totalTokens = usage.totalTokens ?? 0;

  logger.info("AI call completed", {
    userId,
    emailAccountId,
    label,
    provider,
    model,
    isUserApiKey,
    inputTokens,
    cachedInputTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningTokens,
    totalTokens,
    estimatedCost,
    platformCost,
    providerReportedCost,
    providerUpstreamInferenceCost,
    providerCostSource,
    providerRequestId: providerRequestIds?.at(-1),
    providerRequestIds,
    stepCount,
    toolCallCount,
    modelFallbacks,
    usageIncomplete,
  });

  notifyAiUsageListeners({
    cachedInputTokens,
    cacheWriteTokens,
    estimatedCost,
    inputTokens,
    label,
    model,
    outputTokens,
    platformCost,
    provider,
    providerCostSource,
    providerReportedCost,
    providerUpstreamInferenceCost,
    reasoningTokens,
    totalTokens,
  });

  const [analyticsResult, redisResult] = await Promise.allSettled([
    invokeUsageSink(() =>
      publishAiCall({
        userId: userId ?? email,
        emailAccountId,
        provider,
        model,
        totalTokens,
        completionTokens: outputTokens,
        promptTokens: inputTokens,
        cachedInputTokens,
        cacheWriteTokens,
        reasoningTokens,
        cost: platformCost,
        estimatedCost,
        providerReportedCost,
        providerUpstreamInferenceCost,
        providerCostSource,
        isUserApiKey: toTinybirdBoolean(isUserApiKey),
        timestamp: Date.now(),
        label,
        stepCount,
        toolCallCount,
      }),
    ),
    invokeUsageSink(() =>
      saveUsage({ userId, emailAccountId, cost: platformCost, usage }),
    ),
  ]);

  if (analyticsResult.status === "rejected") {
    logger.error("Failed to publish AI usage analytics", {
      error: analyticsResult.reason,
    });
  }
  if (redisResult.status === "rejected") {
    logger.error("Failed to save AI usage to Redis", {
      error: redisResult.reason,
    });
  }
}

export function calculateUsageCost(options: {
  provider: string;
  model: string;
  usage: LanguageModelUsage;
  // Per-request usage of a multi-step run. Needed for models whose rate
  // depends on each request's prompt size; `usage` is the run's sum.
  stepUsages?: LanguageModelUsage[];
}): number {
  const { provider, model, usage, stepUsages } = options;
  const pricing = getModelPricing({ provider, model });
  if (!pricing) return 0;

  if (pricing.longPrompt && stepUsages?.length) {
    return stepUsages.reduce(
      (total, stepUsage) => total + calculateRequestCost(pricing, stepUsage),
      0,
    );
  }

  return calculateRequestCost(pricing, usage);
}

function calculateRequestCost(
  pricing: ModelPricing,
  usage: LanguageModelUsage,
): number {
  const normalizedCachedInputTokens = Math.max(
    0,
    usage.inputTokenDetails?.cacheReadTokens ?? 0,
  );
  const normalizedCacheWriteTokens = Math.max(
    0,
    usage.inputTokenDetails?.cacheWriteTokens ?? 0,
  );
  const inputTokens = Math.max(
    0,
    usage.inputTokens ??
      normalizedCachedInputTokens + normalizedCacheWriteTokens,
  );
  const cachedInputTokens = Math.min(inputTokens, normalizedCachedInputTokens);
  const cacheWriteTokens = Math.min(
    inputTokens - cachedInputTokens,
    normalizedCacheWriteTokens,
  );
  const uncachedInputTokens = Math.max(
    0,
    inputTokens - cachedInputTokens - cacheWriteTokens,
  );
  const outputTokens = Math.max(0, usage.outputTokens ?? 0);
  const rates =
    pricing.longPrompt && inputTokens > pricing.longPrompt.thresholdTokens
      ? pricing.longPrompt
      : pricing;
  const cachedInputTokenPrice = rates.cachedInput ?? rates.input;
  const cacheWriteTokenPrice = rates.cacheWrite ?? rates.input;

  return (
    uncachedInputTokens * rates.input +
    cachedInputTokens * cachedInputTokenPrice +
    cacheWriteTokens * cacheWriteTokenPrice +
    outputTokens * rates.output
  );
}

function getModelPricing(options: {
  provider: string;
  model: string;
}): ModelPricing | undefined {
  const { provider, model } = options;
  const providerId = provider.toLowerCase();

  for (const candidate of buildModelLookupCandidates({
    model,
    provider: providerId,
  })) {
    if (providerId === "openrouter") {
      const openRouterPricing = OPENROUTER_MODEL_PRICING[candidate];
      if (openRouterPricing) return openRouterPricing;
    }

    const fallbackPricing = STATIC_MODEL_PRICING[candidate];
    if (fallbackPricing) return fallbackPricing;

    if (providerId !== "openrouter") {
      const openRouterPricing = OPENROUTER_MODEL_PRICING[candidate];
      if (openRouterPricing) return openRouterPricing;
    }
  }

  return;
}

function getPlatformCost({
  estimatedCost,
  providerReportedCost,
  providerUpstreamInferenceCost,
}: {
  estimatedCost: number;
  providerReportedCost?: number;
  providerUpstreamInferenceCost?: number;
}) {
  if (isPositiveFiniteNumber(providerReportedCost)) {
    return providerReportedCost;
  }
  if (isPositiveFiniteNumber(providerUpstreamInferenceCost)) {
    return providerUpstreamInferenceCost;
  }
  if (estimatedCost > 0) return estimatedCost;

  if (isNonNegativeFiniteNumber(providerReportedCost))
    return providerReportedCost;
  if (isNonNegativeFiniteNumber(providerUpstreamInferenceCost)) {
    return providerUpstreamInferenceCost;
  }

  return estimatedCost;
}

function isPositiveFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegativeFiniteNumber(value: number | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function buildModelLookupCandidates({
  provider,
  model,
}: {
  provider: string;
  model: string;
}): string[] {
  const noOnlineSuffix = stripOnlineModelSuffix(model);

  const candidates = [model, noOnlineSuffix];
  const unprefixed = noOnlineSuffix.includes("/")
    ? noOnlineSuffix.split("/").at(-1)
    : null;

  if (unprefixed) {
    candidates.push(unprefixed);
  } else {
    const providerPrefix = getOpenRouterProviderPrefix(provider);
    if (providerPrefix) {
      candidates.push(`${providerPrefix}/${noOnlineSuffix}`);
    }
  }

  return [...new Set(candidates)];
}

function notifyAiUsageListeners(event: AiUsageEvent): void {
  for (const listener of aiUsageListeners) {
    try {
      listener(event);
    } catch (error) {
      logger.error("AI usage listener failed", { error });
    }
  }
}

function toTinybirdBoolean(value: boolean): 0 | 1 {
  return value ? 1 : 0;
}

function invokeUsageSink(operation: () => unknown) {
  return new Promise<unknown>((resolve) => resolve(operation()));
}
