"use client";

import type {
  EmailEditorAssistContext,
  EmailEditorHandle,
} from "@inboxzero/email-editor/web";
import { markdownToEmailHtml } from "@inboxzero/email-editor/markdown";
import {
  type RefObject,
  useCallback,
  useEffect,
  useReducer,
  useRef,
  useState,
} from "react";
import type { ComposeAssistBody } from "@/app/api/ai/compose-assist/validation";
import { ComposeAssistPanel } from "./ComposeAssistPanel";
import {
  type AssistRequest,
  assistReducer,
  refineRequest,
} from "./compose-assist-state";
import { streamComposeAssist } from "./compose-assist-stream";

const DRAFT_CHANGED_MESSAGE =
  "Your draft changed while Cue was writing. Select the text and try again.";
const ACCEPTED_MESSAGE = `Cue's suggestion added. Undo with ${
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/u.test(navigator.userAgent)
    ? "Command"
    : "Control"
} Z.`;
const MAX_TEXT = 20_000;
const CONTEXT_BEFORE = 6000;
const CONTEXT_AFTER = 2000;
const TOO_LONG_MESSAGE =
  "That's more text than Cue can rewrite at once. Select a shorter passage.";
const IMAGES_MESSAGE =
  "Cue can only rewrite text. Select the words without the images.";

/**
 * Cue's writing help in the composer: rewriting a selection, writing at the
 * caret, continuing, and turning notes into an email. Suggestions are shown
 * beside the draft and only enter it when accepted; nothing is ever sent.
 */
export function useComposeAssist({
  editorRef,
  emailAccountId,
  threadId,
  getEnvelope,
  formRef,
}: {
  editorRef: RefObject<EmailEditorHandle | null>;
  emailAccountId: string;
  threadId?: string;
  getEnvelope: () => { to?: string; subject?: string };
  // The composer Cue works in. Escape inside it closes Cue first.
  formRef: RefObject<HTMLElement | null>;
}) {
  const [state, dispatch] = useReducer(assistReducer, { status: "closed" });
  const stateRef = useRef(state);
  stateRef.current = state;
  const abortRef = useRef<AbortController | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [container, setContainer] = useState<HTMLElement | null>(null);
  // Outlives the panel, so the outcome of accepting is still announced.
  const [announcement, setAnnouncement] = useState("");
  const contextRef = useRef({ emailAccountId, threadId, getEnvelope });
  contextRef.current = { emailAccountId, threadId, getEnvelope };

  const stop = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const close = useCallback(
    ({ refocus = true }: { refocus?: boolean } = {}) => {
      stop();
      editorRef.current?.endAssist();
      dispatch({ type: "close" });
      if (refocus) editorRef.current?.focus();
    },
    [editorRef, stop],
  );

  const begin = useCallback(
    (scope: "selection" | "body") => {
      stop();
      setAnnouncement("");
      const editor = editorRef.current;
      const context = editor?.beginAssist(scope);
      if (!context) return null;
      // Inside a compose dialog, which keeps focus within itself.
      setContainer(
        formRef.current?.closest<HTMLElement>("[role='dialog']") ??
          document.body,
      );
      return context;
    },
    [editorRef, formRef, stop],
  );

  const run = useCallback(
    (request: AssistRequest, context: EmailEditorAssistContext) => {
      stop();
      dispatch({ type: "run", request });
      if (context.containsImages && request.mode !== "write") {
        dispatch({ type: "fail", message: IMAGES_MESSAGE });
        return;
      }
      if (
        (request.mode === "rewrite" || request.mode === "expand-notes") &&
        context.text.length > MAX_TEXT
      ) {
        dispatch({ type: "fail", message: TOO_LONG_MESSAGE });
        return;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const { emailAccountId, threadId, getEnvelope } = contextRef.current;
      streamComposeAssist({
        emailAccountId,
        body: {
          ...toRequestBody(request, context),
          ...getEnvelope(),
          threadId,
        },
        signal: controller.signal,
        onText: (text) => {
          if (!controller.signal.aborted) dispatch({ type: "chunk", text });
        },
      }).then(
        () => {
          if (!controller.signal.aborted) dispatch({ type: "done" });
        },
        (error: unknown) => {
          if (controller.signal.aborted) return;
          dispatch({
            type: "fail",
            message:
              error instanceof Error
                ? error.message
                : "Cue couldn't write a suggestion. Try again.",
          });
        },
      );
    },
    [stop],
  );

  const accept = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "ready") return;
    // A suggestion may echo a message someone else wrote, so images in it
    // become text: nothing loads now, and nothing tracks the recipient.
    const html = markdownToEmailHtml(current.output.trim(), { images: false });
    if (!editorRef.current?.commitAssist(html)) {
      dispatch({ type: "fail", message: DRAFT_CHANGED_MESSAGE });
      return;
    }
    dispatch({ type: "close" });
    setAnnouncement(ACCEPTED_MESSAGE);
  }, [editorRef]);

  const retry = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "ready" || current.status === "error")
      run(current.request, current.context);
  }, [run]);

  const refine = useCallback(
    (text: string) => {
      const current = stateRef.current;
      if (
        current.status === "ready" ||
        current.status === "error" ||
        current.status === "streaming"
      )
        run(refineRequest(current.request, text), current.context);
    },
    [run],
  );

  /** ⌘J, the phone button, or Cue in the selection toolbar. */
  const open = useCallback(() => {
    if (stateRef.current.status !== "closed") {
      focusPanel(panelRef.current);
      return;
    }
    const context = begin("selection");
    if (!context) return;
    dispatch(
      context.target === "selection"
        ? { type: "openMenu", context }
        : { type: "openPrompt", context },
    );
  }, [begin]);

  /** "Ask Cue" in the snippet picker, carrying what was typed after "/". */
  const openPrompt = useCallback(
    (draft: string) => {
      const context = begin("selection");
      if (context) dispatch({ type: "openPrompt", context, draft });
    },
    [begin],
  );

  const continueWriting = useCallback(() => {
    const current = stateRef.current;
    if (current.status !== "prompt") return;
    run(
      { mode: "continue", refinements: [], label: "Continue writing" },
      current.context,
    );
  }, [run]);

  const expandNotes = useCallback(() => {
    const context = begin("body");
    if (!context) return;
    dispatch({ type: "openPrompt", context });
    run(
      { mode: "expand-notes", refinements: [], label: "Turn notes into email" },
      context,
    );
  }, [begin, run]);

  /**
   * ⌘↵ and the Send button while Cue is open: never send. A ready
   * suggestion is accepted instead; anything else stays as it is.
   */
  const interceptSend = useCallback(() => {
    const current = stateRef.current;
    if (current.status === "closed") return false;
    if (current.status === "ready") accept();
    else focusPanel(panelRef.current);
    return true;
  }, [accept]);

  // Keys the panel owns even where the compose dialog or the browser would
  // otherwise take them: Escape, ⌘↵ and ⌘R. Escape anywhere in the composer
  // closes Cue rather than the composer.
  useEffect(() => {
    if (state.status === "closed") return;
    const onKeyDown = (event: KeyboardEvent) => {
      const panel = panelRef.current;
      if (!panel || !(event.target instanceof Node)) return;
      if (event.isComposing) return;
      if (!panel.contains(event.target)) {
        if (event.key === "Escape" && formRef.current?.contains(event.target)) {
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        return;
      }
      const mod = event.metaKey || event.ctrlKey;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      } else if (mod && event.key === "Enter") {
        event.preventDefault();
        event.stopPropagation();
        accept();
      } else if (mod && event.key.toLowerCase() === "r" && !event.shiftKey) {
        event.preventDefault();
        event.stopPropagation();
        retry();
      }
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [accept, close, formRef, retry, state.status]);

  // A menu or prompt left behind by a click elsewhere goes away; a
  // suggestion stays until it is accepted or discarded.
  useEffect(() => {
    if (state.status !== "menu" && state.status !== "prompt") return;
    const onPointerDown = (event: PointerEvent) => {
      if (
        event.target instanceof Node &&
        panelRef.current?.contains(event.target)
      )
        return;
      close({ refocus: false });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () =>
      document.removeEventListener("pointerdown", onPointerDown, true);
  }, [close, state.status]);

  useEffect(() => () => stop(), [stop]);

  const panel = (
    <>
      <span className="sr-only" role="status">
        {announcement}
      </span>
      {state.status !== "closed" && container ? (
        <ComposeAssistPanel
          container={container}
          getAnchor={() => editorRef.current?.getAssistAnchor() ?? null}
          onAccept={accept}
          onClose={close}
          onContinue={continueWriting}
          onExpandNotes={expandNotes}
          onRefine={refine}
          onRetry={retry}
          onRun={(request) => run(request, state.context)}
          panelRef={panelRef}
          state={state}
        />
      ) : null}
    </>
  );

  const focus = useCallback(() => focusPanel(panelRef.current), []);

  return {
    focus,
    isOpen: state.status !== "closed",
    interceptSend,
    open,
    openPrompt,
    panel,
  };
}

function toRequestBody(
  request: AssistRequest,
  context: EmailEditorAssistContext,
): ComposeAssistBody {
  const { label: _label, ...fields } = request;
  if (request.mode === "expand-notes") return { ...fields, text: context.text };
  // The model reads the text nearest the edit; the rest of a long draft
  // only adds cost.
  const before = context.before.slice(-CONTEXT_BEFORE);
  const after = context.after.slice(0, CONTEXT_AFTER);
  if (request.mode === "rewrite")
    return { ...fields, before, text: context.text, after };
  return { ...fields, before, after };
}

function focusPanel(panel: HTMLElement | null) {
  panel
    ?.querySelector<HTMLElement>("input, [role='menuitem'][tabindex='0']")
    ?.focus();
}
