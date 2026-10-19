const DEFAULT_EVAL_JUDGE_PROVIDER = "openrouter";
const DEFAULT_EVAL_JUDGE_MODEL = "deepseek/deepseek-v4.1-flash";
const ANTHROPIC_EVAL_JUDGE_MODEL = "claude-sonnet-5-5";

/**
 * Lives apart from the judge implementations because those reach vitest through
 * the debug-artifact writer, and standalone eval scripts (which run under tsx,
 * not vitest) still need to resolve which model grades the run.
 */
export function getEvalJudgeUserAi() {
  const useAnthropicDefault =
    !process.env.OPENROUTER_API_KEY && Boolean(process.env.ANTHROPIC_API_KEY);
  const aiProvider =
    process.env.EVAL_JUDGE_PROVIDER ||
    (useAnthropicDefault ? "anthropic" : DEFAULT_EVAL_JUDGE_PROVIDER);
  const aiModel =
    process.env.EVAL_JUDGE_MODEL ||
    (aiProvider === "anthropic"
      ? ANTHROPIC_EVAL_JUDGE_MODEL
      : DEFAULT_EVAL_JUDGE_MODEL);
  const aiApiKey = getEvalJudgeApiKey(aiProvider);
  if (!aiApiKey) return;

  return {
    aiProvider,
    aiModel,
    aiApiKey,
  };
}

function getEvalJudgeApiKey(provider: string) {
  const providerApiKeys: Record<string, string | undefined> = {
    openrouter: process.env.OPENROUTER_API_KEY,
    openai: process.env.OPENAI_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY,
    google: process.env.GOOGLE_API_KEY,
    groq: process.env.GROQ_API_KEY,
    cerebras: process.env.CEREBRAS_API_KEY,
  };

  return providerApiKeys[provider];
}
