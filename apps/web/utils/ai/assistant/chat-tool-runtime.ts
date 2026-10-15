import type { Tool } from "ai";
import { isProviderRateLimitModeError } from "@/utils/email/rate-limit-mode-error";
import {
  createGmailQuotaStats,
  getGmailCallDeferredError,
  type GmailQuotaStats,
  runWithGmailQuota,
} from "@/utils/gmail/quota";
import type { Logger } from "@/utils/logger";

// Someone is waiting on the reply, so a tool call's Gmail calls together wait
// at most this long for the account's budget. Past it the tool reports that
// Gmail is limiting requests instead of holding the turn.
export const CHAT_TOOL_GMAIL_WAIT_BUDGET_MS = 10_000;

/**
 * Runs every assistant tool call as interactive Gmail traffic, so it never
 * queues behind sync or background work, and logs how each call went: how long
 * it took, how long it waited for the Gmail budget, and why it failed. Never
 * logs inputs or outputs.
 */
export function withChatToolRuntime<T extends Record<string, Tool>>({
  tools,
  logger,
  onGmailCall,
}: {
  tools: T;
  logger: Logger;
  /** Told before each Gmail call any tool makes. */
  onGmailCall?: () => void;
}): T {
  return Object.fromEntries(
    Object.entries(tools).map(([name, definition]) => {
      const execute = definition.execute;
      if (!execute) return [name, definition];
      return [
        name,
        {
          ...definition,
          execute: (...args: Parameters<typeof execute>) => {
            const startedAt = Date.now();
            const gmail = createGmailQuotaStats();
            const output = runWithGmailQuota(
              {
                caller: `chat/${name}`,
                priority: "interactive",
                stats: gmail,
                maxTotalWaitMs: CHAT_TOOL_GMAIL_WAIT_BUDGET_MS,
                onAdmit: onGmailCall,
              },
              () => execute(...args),
            );
            if (!isPromiseLike(output)) return output;
            return Promise.resolve(output).then(
              (result) => {
                logToolCall({
                  logger,
                  tool: name,
                  startedAt,
                  gmail,
                  errorCode: hasErrorResult(result)
                    ? errorCodeFromStats(gmail)
                    : undefined,
                  outcome: hasErrorResult(result) ? "error_result" : "ok",
                });
                return result;
              },
              (error: unknown) => {
                logToolCall({
                  logger,
                  tool: name,
                  startedAt,
                  gmail,
                  errorCode: errorCodeFor(error, gmail),
                  outcome: "threw",
                });
                throw error;
              },
            );
          },
        },
      ];
    }),
  ) as T;
}

function logToolCall({
  logger,
  tool,
  startedAt,
  gmail,
  outcome,
  errorCode,
}: {
  logger: Logger;
  tool: string;
  startedAt: number;
  gmail: GmailQuotaStats;
  outcome: "ok" | "error_result" | "threw";
  errorCode?: string;
}) {
  const fields = {
    tool,
    outcome,
    durationMs: Date.now() - startedAt,
    gmailWaitMs: gmail.waitMs,
    gmailDeferred: gmail.deferred,
    gmailRefused: gmail.refused,
    rateLimitModeSkips: gmail.rateLimitMode,
    ...(errorCode ? { errorCode } : {}),
  };
  if (outcome === "ok")
    logger.info("Assistant chat tool call finished", fields);
  else logger.warn("Assistant chat tool call finished", fields);
}

function errorCodeFor(error: unknown, gmail: GmailQuotaStats) {
  if (getGmailCallDeferredError(error)) return "GMAIL_CALL_DEFERRED";
  if (isProviderRateLimitModeError(error)) return "PROVIDER_RATE_LIMIT_MODE";
  const fromStats = errorCodeFromStats(gmail);
  if (fromStats) return fromStats;
  return error instanceof Error ? error.name : "unknown";
}

// Tools catch their own errors and return `{ error }`, so the gate's record of
// the call is what says whether Gmail's budget was the cause.
function errorCodeFromStats(gmail: GmailQuotaStats) {
  if (gmail.deferred > 0) return "GMAIL_CALL_DEFERRED";
  if (gmail.refused > 0) return "GMAIL_QUOTA_REFUSED";
  if (gmail.rateLimitMode > 0) return "PROVIDER_RATE_LIMIT_MODE";
  return;
}

function hasErrorResult(result: unknown) {
  if (!result || typeof result !== "object") return false;
  return (
    ("error" in result && Boolean(result.error)) ||
    ("success" in result && result.success === false)
  );
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    "then" in value &&
    typeof value.then === "function"
  );
}
