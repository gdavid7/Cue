import type { EmailEditorAssistContext } from "@inboxzero/email-editor/web";
import type { ComposeAssistBody } from "@/app/api/ai/compose-assist/validation";

export type AssistRequest = Pick<
  ComposeAssistBody,
  "mode" | "action" | "language" | "instruction"
> & {
  refinements: string[];
  // What the user asked for, as the panel names it.
  label: string;
};

export type AssistState =
  | { status: "closed" }
  // Choosing what to do with the selected text.
  | { status: "menu"; context: EmailEditorAssistContext }
  // The ⌘J box, asking what to write at the caret.
  | { status: "prompt"; context: EmailEditorAssistContext; draft: string }
  | {
      status: "streaming" | "ready";
      context: EmailEditorAssistContext;
      request: AssistRequest;
      output: string;
    }
  | {
      status: "error";
      context: EmailEditorAssistContext;
      request: AssistRequest;
      message: string;
    };

export type AssistEvent =
  | { type: "openMenu"; context: EmailEditorAssistContext }
  | { type: "openPrompt"; context: EmailEditorAssistContext; draft?: string }
  | { type: "run"; request: AssistRequest }
  | { type: "chunk"; text: string }
  | { type: "done" }
  | { type: "fail"; message: string }
  | { type: "close" };

export const EMPTY_SUGGESTION_MESSAGE =
  "Cue didn't suggest anything. Try again or say it differently.";

export function assistReducer(
  state: AssistState,
  event: AssistEvent,
): AssistState {
  switch (event.type) {
    case "openMenu":
      return { status: "menu", context: event.context };
    case "openPrompt":
      return {
        status: "prompt",
        context: event.context,
        draft: event.draft ?? "",
      };
    case "run":
      if (state.status === "closed") return state;
      return {
        status: "streaming",
        context: state.context,
        request: event.request,
        output: "",
      };
    case "chunk":
      if (state.status !== "streaming") return state;
      return { ...state, output: state.output + event.text };
    case "done":
      if (state.status !== "streaming") return state;
      if (!state.output.trim()) {
        return {
          status: "error",
          context: state.context,
          request: state.request,
          message: EMPTY_SUGGESTION_MESSAGE,
        };
      }
      return { ...state, status: "ready" };
    case "fail":
      // A ready suggestion can still fail to apply.
      if (state.status !== "streaming" && state.status !== "ready")
        return state;
      return {
        status: "error",
        context: state.context,
        request: state.request,
        message: event.message,
      };
    case "close":
      return { status: "closed" };
  }
}

/** The same request with a follow-up the user typed after seeing the result. */
export function refineRequest(
  request: AssistRequest,
  refinement: string,
): AssistRequest {
  return {
    ...request,
    refinements: [...request.refinements, refinement].slice(-5),
  };
}
