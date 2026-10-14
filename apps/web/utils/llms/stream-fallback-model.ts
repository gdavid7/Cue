import type {
  LanguageModelV4,
  LanguageModelV4CallOptions,
  LanguageModelV4StreamPart,
  LanguageModelV4StreamResult,
} from "@ai-sdk/provider";
import { sleep } from "@/utils/sleep";

export type StreamFallbackCandidate = {
  provider: string;
  modelName: string;
  model: LanguageModelV4;
  providerOptions: LanguageModelV4CallOptions["providerOptions"];
};

export const INTERRUPTED_RESPONSE_NOTICE =
  "The AI provider stopped responding before this reply was finished, so it may be incomplete. Please try again.";

// Moves a tool loop to the next model candidate when a provider fails, at the
// level of a single model call. Each agent step is one call whose prompt
// already holds the earlier steps' tool results, and the AI SDK only executes
// a call's tool calls once that call finishes cleanly, so switching models
// never re-runs a tool. A call switches only while the user has seen none of
// its output; after that it is ended with a notice rather than answered twice.
export function createStreamFallbackModel<
  TCandidate extends StreamFallbackCandidate,
>({
  candidates,
  shouldFallback,
  getRetryDelayMs,
  onRetry,
  onFallback,
  onInterrupted,
}: {
  candidates: TCandidate[];
  // Whether a failure is one another model could get past (rate limits,
  // outages, refusals) rather than a request no model would accept.
  shouldFallback: (error: unknown) => boolean;
  // How long to wait before retrying the primary once, or undefined when a
  // retry is not worth it. Bounded by the caller to keep the delay short.
  getRetryDelayMs: (error: unknown) => number | undefined;
  onRetry: (event: {
    candidate: TCandidate;
    error: unknown;
    delayMs: number;
  }) => void;
  onFallback: (event: {
    from: TCandidate;
    to: TCandidate;
    error: unknown;
  }) => void;
  onInterrupted: (event: { candidate: TCandidate; error: unknown }) => void;
}): LanguageModelV4 & { getActiveCandidate(): TCandidate } {
  if (candidates.length === 0) throw new Error("No model candidates");

  // Stays on the fallback for the rest of the run: the failing provider is
  // likely to fail the next step too.
  let activeIndex = 0;
  let primaryRetried = false;
  const getActiveCandidate = () => candidates[activeIndex];

  // Called when a model call fails before the user has seen any of its
  // output. Returns whether the call should be started again: once on the
  // primary for a passing failure, then on the next candidate.
  const recoverFrom = async (
    error: unknown,
    abortSignal: AbortSignal | undefined,
  ) => {
    if (abortSignal?.aborted || isAbortError(error)) return false;

    if (activeIndex === 0 && !primaryRetried) {
      const delayMs = getRetryDelayMs(error);
      if (delayMs !== undefined) {
        primaryRetried = true;
        onRetry({ candidate: getActiveCandidate(), error, delayMs });
        await sleep(delayMs);
        return !abortSignal?.aborted;
      }
    }

    const from = candidates[activeIndex];
    const to = candidates[activeIndex + 1];
    if (!to || !shouldFallback(error)) return false;

    activeIndex += 1;
    onFallback({ from, to, error });
    return true;
  };

  const getCallOptions = (options: LanguageModelV4CallOptions) =>
    // Step options carry the primary's provider options (and any per-step
    // overrides), so only fallbacks swap in their own.
    activeIndex === 0
      ? options
      : { ...options, providerOptions: getActiveCandidate().providerOptions };

  const startStream = async (
    options: LanguageModelV4CallOptions,
  ): Promise<LanguageModelV4StreamResult> => {
    while (true) {
      try {
        return await getActiveCandidate().model.doStream(
          getCallOptions(options),
        );
      } catch (error) {
        if (!(await recoverFrom(error, options.abortSignal))) throw error;
      }
    }
  };

  return {
    specificationVersion: "v4",
    get provider() {
      return getActiveCandidate().model.provider;
    },
    get modelId() {
      return getActiveCandidate().model.modelId;
    },
    get supportedUrls() {
      return getActiveCandidate().model.supportedUrls;
    },
    getActiveCandidate,
    async doGenerate(options) {
      while (true) {
        try {
          return await getActiveCandidate().model.doGenerate(
            getCallOptions(options),
          );
        } catch (error) {
          if (!(await recoverFrom(error, options.abortSignal))) throw error;
        }
      }
    },
    async doStream(options) {
      const initial = await startStream(options);
      return {
        ...initial,
        stream: guardStream(initial.stream, options),
      };
    },
  };

  function guardStream(
    initialStream: ReadableStream<LanguageModelV4StreamPart>,
    options: LanguageModelV4CallOptions,
  ) {
    let reader = initialStream.getReader();
    // Set once the user has seen this call's output (text, or reasoning the
    // chat shows). Until then every content part is held, so a call that fails
    // leaves nothing behind: not in the UI, and not in the step content the
    // next model is prompted with.
    let outputStarted = false;
    let skipStreamStart = false;
    // Tool parts (and anything after them) wait for the call to finish, as the
    // AI SDK runs a tool as soon as it sees the call.
    let held: LanguageModelV4StreamPart[] = [];
    const openTextIds = new Set<string>();
    const openReasoningIds = new Set<string>();

    return new ReadableStream<LanguageModelV4StreamPart>({
      async pull(controller) {
        const emit = (part: LanguageModelV4StreamPart) => {
          trackOpenParts(part, openTextIds, openReasoningIds);
          controller.enqueue(part);
        };
        const releaseHeld = () => {
          for (const part of held) emit(part);
          held = [];
        };

        while (true) {
          let part: LanguageModelV4StreamPart;
          try {
            const next = await reader.read();
            if (next.done) {
              releaseHeld();
              controller.close();
              return;
            }
            part = next.value;
          } catch (error) {
            part = { type: "error", error };
          }

          if (part.type === "error") {
            await reader.cancel(part.error).catch(() => {});

            const aborted =
              options.abortSignal?.aborted || isAbortError(part.error);
            if (outputStarted && !aborted) {
              onInterrupted({
                candidate: getActiveCandidate(),
                error: part.error,
              });
              held = [];
              closeOpenParts(controller, openTextIds, openReasoningIds);
              emitInterruptedNotice(controller);
              controller.enqueue({
                type: "finish",
                finishReason: { unified: "error", raw: undefined },
                usage: UNKNOWN_USAGE,
              });
              controller.close();
              return;
            }

            if (!(await recoverFrom(part.error, options.abortSignal))) {
              releaseHeld();
              emit(part);
              controller.close();
              return;
            }

            held = [];
            try {
              reader = (await startStream(options)).stream.getReader();
              skipStreamStart = true;
            } catch (error) {
              emit({ type: "error", error });
              controller.close();
              return;
            }
            continue;
          }

          if (part.type === "stream-start" && skipStreamStart) {
            skipStreamStart = false;
            continue;
          }

          if (part.type === "finish") {
            releaseHeld();
            emit(part);
            return;
          }

          if (held.some(isToolPart) || isToolPart(part)) {
            held.push(part);
            continue;
          }

          if (!outputStarted && !isCallMetadata(part)) {
            if (!isUserVisibleOutput(part)) {
              held.push(part);
              continue;
            }
            outputStarted = true;
            releaseHeld();
          }
          emit(part);
          return;
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
  }
}

const UNKNOWN_USAGE = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

function isToolPart(part: LanguageModelV4StreamPart) {
  return (
    part.type === "tool-input-start" ||
    part.type === "tool-input-delta" ||
    part.type === "tool-input-end" ||
    part.type === "tool-call" ||
    part.type === "tool-approval-request" ||
    part.type === "tool-result"
  );
}

function isCallMetadata(part: LanguageModelV4StreamPart) {
  return (
    part.type === "stream-start" ||
    part.type === "response-metadata" ||
    part.type === "raw"
  );
}

// Matches what the chat renders: it hides empty and redacted reasoning.
function isUserVisibleOutput(part: LanguageModelV4StreamPart) {
  if (part.type === "text-delta") return part.delta.length > 0;
  if (part.type === "reasoning-delta") {
    return part.delta.trim().length > 0 && part.delta !== "[REDACTED]";
  }
  return false;
}

function trackOpenParts(
  part: LanguageModelV4StreamPart,
  openTextIds: Set<string>,
  openReasoningIds: Set<string>,
) {
  if (part.type === "text-start") openTextIds.add(part.id);
  else if (part.type === "text-end") openTextIds.delete(part.id);
  else if (part.type === "reasoning-start") openReasoningIds.add(part.id);
  else if (part.type === "reasoning-end") openReasoningIds.delete(part.id);
}

function closeOpenParts(
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
  openTextIds: Set<string>,
  openReasoningIds: Set<string>,
) {
  for (const id of openTextIds) controller.enqueue({ type: "text-end", id });
  openTextIds.clear();
  for (const id of openReasoningIds) {
    controller.enqueue({ type: "reasoning-end", id });
  }
  openReasoningIds.clear();
}

function emitInterruptedNotice(
  controller: ReadableStreamDefaultController<LanguageModelV4StreamPart>,
) {
  const id = "stream-interrupted-notice";
  controller.enqueue({ type: "text-start", id });
  controller.enqueue({
    type: "text-delta",
    id,
    delta: `\n\n${INTERRUPTED_RESPONSE_NOTICE}`,
  });
  controller.enqueue({ type: "text-end", id });
}

function isAbortError(error: unknown) {
  return (
    error instanceof Error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  );
}
