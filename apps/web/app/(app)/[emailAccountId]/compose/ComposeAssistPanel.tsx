"use client";

import {
  ArrowLeftIcon,
  CheckIcon,
  Loader2Icon,
  RotateCcwIcon,
  XIcon,
} from "lucide-react";
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { Kbd } from "@/components/Kbd";
import { Button } from "@/components/ui/button";
import { cn } from "@/utils";
import type { AssistRequest, AssistState } from "./compose-assist-state";
import { type DiffPart, looksLikeNotes, wordDiff } from "./compose-assist-text";

const MOD_KEY =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad/u.test(navigator.userAgent)
    ? "⌘"
    : "Ctrl+";

type RewriteAction = NonNullable<AssistRequest["action"]>;

const REWRITE_ACTIONS: {
  action: RewriteAction;
  label: string;
  key?: string;
}[] = [
  { action: "improve", label: "Improve", key: "i" },
  { action: "shorter", label: "Shorter", key: "s" },
  { action: "formal", label: "More formal" },
  { action: "friendly", label: "More friendly" },
  { action: "grammar", label: "Fix grammar", key: "g" },
  { action: "translate", label: "Translate…", key: "t" },
  { action: "custom", label: "Custom…" },
];

const LANGUAGES = [
  "English",
  "Spanish",
  "French",
  "German",
  "Portuguese",
  "Italian",
  "Dutch",
  "Hebrew",
  "Arabic",
  "Russian",
  "Ukrainian",
  "Polish",
  "Turkish",
  "Hindi",
  "Chinese",
  "Japanese",
  "Korean",
];

export function ComposeAssistPanel({
  container,
  getAnchor,
  panelRef,
  state,
  onAccept,
  onClose,
  onContinue,
  onExpandNotes,
  onRefine,
  onRetry,
  onRun,
}: {
  container: HTMLElement;
  getAnchor: () => DOMRect | null;
  panelRef: RefObject<HTMLDivElement | null>;
  state: Exclude<AssistState, { status: "closed" }>;
  onAccept: () => void;
  onClose: () => void;
  onContinue: () => void;
  onExpandNotes: () => void;
  onRefine: (text: string) => void;
  onRetry: () => void;
  onRun: (request: AssistRequest) => void;
}) {
  const position = usePanelPosition({ container, getAnchor, panelRef });
  const statusId = useId();

  return createPortal(
    <div
      aria-describedby={statusId}
      aria-label="Cue"
      className={cn(
        "z-[100] w-[min(30rem,calc(100vw-1rem))] origin-top rounded-lg border bg-popover text-popover-foreground text-sm shadow-lg",
        "motion-safe:fade-in-0 motion-safe:zoom-in-95 motion-safe:animate-in motion-reduce:fade-in-0 motion-reduce:animate-in",
        container === document.body ? "fixed" : "absolute",
      )}
      data-compose-assist=""
      ref={panelRef}
      role="dialog"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? undefined : "hidden",
      }}
    >
      {state.status === "menu" ? (
        <RewriteMenu onRun={onRun} />
      ) : state.status === "prompt" ? (
        <PromptBox
          draftText={`${state.context.before}${state.context.after}`}
          initialText={state.draft}
          onContinue={onContinue}
          onExpandNotes={onExpandNotes}
          onRun={onRun}
        />
      ) : (
        <Preview
          onAccept={onAccept}
          onClose={onClose}
          onRefine={onRefine}
          onRetry={onRetry}
          state={state}
        />
      )}
      <p className="sr-only" id={statusId} role="status">
        {state.status === "streaming"
          ? "Cue is writing."
          : state.status === "ready"
            ? "Suggestion ready. Press Enter to accept or Escape to discard."
            : ""}
      </p>
    </div>,
    container,
  );
}

function RewriteMenu({ onRun }: { onRun: (request: AssistRequest) => void }) {
  const [view, setView] = useState<"actions" | "translate" | "custom">(
    "actions",
  );
  const [active, setActive] = useState(0);
  const itemsRef = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (view === "actions") itemsRef.current[active]?.focus();
  }, [active, view]);

  const choose = (action: RewriteAction) => {
    if (action === "translate") return setView("translate");
    if (action === "custom") return setView("custom");
    const label = REWRITE_ACTIONS.find((item) => item.action === action)?.label;
    onRun({ mode: "rewrite", action, refinements: [], label: label ?? "" });
  };

  if (view === "custom") {
    return (
      <TextRequest
        label="How should Cue change it?"
        onBack={() => setView("actions")}
        onSubmit={(instruction) =>
          onRun({
            mode: "rewrite",
            action: "custom",
            instruction,
            refinements: [],
            label: instruction,
          })
        }
        placeholder="e.g. make it sound less urgent"
      />
    );
  }
  if (view === "translate") {
    return (
      <LanguagePicker
        onBack={() => setView("actions")}
        onPick={(language) =>
          onRun({
            mode: "rewrite",
            action: "translate",
            language,
            refinements: [],
            label: `Translate to ${language}`,
          })
        }
      />
    );
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const count = REWRITE_ACTIONS.length;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      setActive(
        (index) =>
          (index + (event.key === "ArrowDown" ? 1 : count - 1)) % count,
      );
      return;
    }
    if (event.key === "Home" || event.key === "End") {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : count - 1);
      return;
    }
    const item = REWRITE_ACTIONS.find(
      (candidate) => candidate.key === event.key.toLowerCase(),
    );
    if (item) {
      event.preventDefault();
      choose(item.action);
    }
  };

  return (
    <div className="p-1">
      <PanelTitle>Rewrite with Cue</PanelTitle>
      <div
        aria-label="Rewrite with Cue"
        aria-orientation="vertical"
        onKeyDown={onKeyDown}
        role="menu"
      >
        {REWRITE_ACTIONS.map((item, index) => (
          <button
            className={cn(
              "flex w-full items-center justify-between rounded-md px-2 py-1.5 text-left max-sm:py-2.5 outline-none",
              "hover:bg-accent focus-visible:bg-accent",
            )}
            key={item.action}
            onClick={() => choose(item.action)}
            onFocus={() => setActive(index)}
            ref={(element) => {
              itemsRef.current[index] = element;
            }}
            role="menuitem"
            tabIndex={index === active ? 0 : -1}
            type="button"
            aria-keyshortcuts={item.key?.toUpperCase()}
          >
            <span>{item.label}</span>
            {item.key ? <KeyHint>{item.key.toUpperCase()}</KeyHint> : null}
          </button>
        ))}
      </div>
    </div>
  );
}

function LanguagePicker({
  onBack,
  onPick,
}: {
  onBack: () => void;
  onPick: (language: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const matches = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return LANGUAGES.filter((language) =>
      language.toLowerCase().startsWith(normalized),
    );
  }, [query]);
  const typed = query.trim();
  const options =
    typed &&
    !matches.some((language) => language.toLowerCase() === typed.toLowerCase())
      ? [...matches, typed]
      : matches;
  const activeIndex = Math.min(active, Math.max(options.length - 1, 0));

  return (
    <div className="p-1">
      <PanelTitle onBack={onBack}>Translate to</PanelTitle>
      <input
        aria-activedescendant={
          options.length ? `${listId}-${activeIndex}` : undefined
        }
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded="true"
        aria-label="Language"
        autoFocus
        className="h-9 w-full rounded-md border bg-transparent px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => {
          setQuery(event.target.value);
          setActive(0);
        }}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const count = options.length || 1;
            setActive(
              (activeIndex + (event.key === "ArrowDown" ? 1 : count - 1)) %
                count,
            );
          } else if (event.key === "Enter") {
            event.preventDefault();
            const language = options[activeIndex];
            if (language) onPick(language);
          }
        }}
        placeholder="Any language"
        role="combobox"
        value={query}
      />
      <div
        aria-label="Languages"
        className="mt-1 max-h-52 overflow-auto"
        id={listId}
        role="listbox"
      >
        {options.map((language, index) => (
          <div
            aria-selected={index === activeIndex}
            className={cn(
              "cursor-pointer rounded-md px-2 py-1.5 max-sm:py-2.5",
              index === activeIndex && "bg-accent",
            )}
            id={`${listId}-${index}`}
            key={language}
            onClick={() => onPick(language)}
            onKeyDown={() => {}}
            onMouseDown={(event) => event.preventDefault()}
            role="option"
            tabIndex={-1}
          >
            {language}
          </div>
        ))}
      </div>
    </div>
  );
}

function TextRequest({
  label,
  placeholder,
  onBack,
  onSubmit,
}: {
  label: string;
  placeholder: string;
  onBack: () => void;
  onSubmit: (text: string) => void;
}) {
  const [text, setText] = useState("");
  return (
    <div className="p-1">
      <PanelTitle onBack={onBack}>{label}</PanelTitle>
      <input
        aria-label={label}
        autoFocus
        className="h-9 w-full rounded-md border bg-transparent px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !text.trim()) return;
          event.preventDefault();
          onSubmit(text.trim());
        }}
        placeholder={placeholder}
        value={text}
      />
    </div>
  );
}

function PromptBox({
  draftText,
  initialText,
  onContinue,
  onExpandNotes,
  onRun,
}: {
  draftText: string;
  initialText: string;
  onContinue: () => void;
  onExpandNotes: () => void;
  onRun: (request: AssistRequest) => void;
}) {
  const [text, setText] = useState(initialText);
  const hasDraft = Boolean(draftText.trim());
  const notesFirst = hasDraft && looksLikeNotes(draftText);
  const chips = [
    ...(hasDraft
      ? [{ label: "Turn notes into email", onPress: onExpandNotes }]
      : []),
    { label: "Continue writing", onPress: onContinue },
  ];
  if (!notesFirst) chips.reverse();

  return (
    <div className="p-2">
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-muted-foreground">
          ✦
        </span>
        <input
          aria-label="Ask Cue to write"
          autoFocus
          className="h-8 min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
          onChange={(event) => setText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              const instruction = text.trim();
              if (!instruction) return onContinue();
              onRun({
                mode: "write",
                instruction,
                refinements: [],
                label: instruction,
              });
            } else if (event.key === "Tab" && !event.shiftKey && !text.trim()) {
              event.preventDefault();
              onContinue();
            }
          }}
          placeholder="Ask Cue to write… e.g. say I'm in, ask for the doc"
          value={text}
        />
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        {chips.map((chip) => (
          <Button
            className="rounded-full max-sm:h-10 max-sm:px-3"
            key={chip.label}
            onClick={chip.onPress}
            size="xs-2"
            type="button"
            variant="outline"
          >
            {chip.label}
          </Button>
        ))}
        <span className="ml-auto hidden text-muted-foreground text-xs sm:inline">
          <Kbd>Tab</Kbd> continue
        </span>
      </div>
    </div>
  );
}

function Preview({
  state,
  onAccept,
  onClose,
  onRefine,
  onRetry,
}: {
  state: Extract<AssistState, { status: "streaming" | "ready" | "error" }>;
  onAccept: () => void;
  onClose: () => void;
  onRefine: (text: string) => void;
  onRetry: () => void;
}) {
  const [refinement, setRefinement] = useState("");
  const { request, context } = state;
  const output = state.status === "error" ? "" : toPlainText(state.output);
  const parts: DiffPart[] =
    request.mode === "rewrite"
      ? wordDiff(context.text, output)
      : [{ kind: "added", text: output }];

  return (
    <div className="p-2">
      <div className="flex items-center gap-2 px-1 text-muted-foreground text-xs">
        <span aria-hidden="true">✦</span>
        <span className="min-w-0 truncate font-medium">{request.label}</span>
        {state.status === "streaming" ? (
          <Loader2Icon
            aria-hidden="true"
            className="size-3.5 shrink-0 motion-safe:animate-spin"
          />
        ) : null}
      </div>
      {state.status === "error" ? (
        <p className="px-1 py-2 text-destructive" role="alert">
          {state.message}
        </p>
      ) : (
        <div
          aria-busy={state.status === "streaming"}
          aria-label="Suggested text"
          role="group"
          className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-md px-1 py-1 leading-relaxed"
          data-compose-assist-output=""
        >
          {parts.map((part, index) =>
            part.kind === "same" ? (
              <span key={index}>{part.text}</span>
            ) : part.kind === "removed" ? (
              <del
                className="text-muted-foreground decoration-red-500/70"
                key={index}
              >
                {part.text}
              </del>
            ) : (
              <ins
                className="rounded-sm bg-emerald-500/15 text-foreground no-underline dark:bg-emerald-400/20"
                key={index}
              >
                {part.text}
              </ins>
            ),
          )}
          {state.status === "streaming" && !output ? (
            <span className="text-muted-foreground">Writing…</span>
          ) : null}
        </div>
      )}
      <input
        aria-label="Ask Cue for changes"
        autoFocus
        className="mt-2 h-8 w-full rounded-md border bg-transparent px-2 outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring"
        onChange={(event) => setRefinement(event.target.value)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" || event.shiftKey) return;
          if (event.metaKey || event.ctrlKey) return;
          event.preventDefault();
          const text = refinement.trim();
          if (text) {
            setRefinement("");
            onRefine(text);
          } else if (state.status === "ready") {
            onAccept();
          }
        }}
        placeholder="Ask for changes, or press Enter to accept"
        value={refinement}
      />
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <Button
          disabled={state.status !== "ready"}
          aria-keyshortcuts="Enter"
          onClick={onAccept}
          size="xs-2"
          className="max-sm:h-10"
          type="button"
        >
          <CheckIcon aria-hidden="true" className="mr-1 size-3.5" />
          Accept
          <KeyHint variant="onColor">↵</KeyHint>
        </Button>
        <Button
          aria-keyshortcuts="Escape"
          className="max-sm:h-10"
          onClick={onClose}
          size="xs-2"
          type="button"
          variant="ghost"
        >
          <XIcon aria-hidden="true" className="mr-1 size-3.5" />
          Discard
          <KeyHint>Esc</KeyHint>
        </Button>
        <Button
          disabled={state.status === "streaming"}
          onClick={onRetry}
          size="xs-2"
          className="max-sm:h-10"
          type="button"
          variant="ghost"
          aria-keyshortcuts={MOD_KEY === "⌘" ? "Meta+R" : "Control+R"}
        >
          <RotateCcwIcon aria-hidden="true" className="mr-1 size-3.5" />
          Retry
          <KeyHint>{MOD_KEY}R</KeyHint>
        </Button>
      </div>
    </div>
  );
}

// Keys are for keyboards: hidden on phones, and from screen readers, which
// get them from aria-keyshortcuts instead.
function KeyHint({
  children,
  variant,
}: {
  children: ReactNode;
  variant?: "onColor";
}) {
  return (
    <Kbd aria-hidden="true" className="ml-1.5 max-sm:hidden" variant={variant}>
      {children}
    </Kbd>
  );
}

function PanelTitle({
  children,
  onBack,
}: {
  children: ReactNode;
  onBack?: () => void;
}) {
  return (
    <div className="flex h-8 items-center gap-1 px-1 font-medium text-muted-foreground text-xs">
      {onBack ? (
        <button
          aria-label="Back"
          className="rounded-sm p-1 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          onClick={onBack}
          type="button"
        >
          <ArrowLeftIcon aria-hidden="true" className="size-3.5" />
        </button>
      ) : (
        <span aria-hidden="true">✦</span>
      )}
      <span>{children}</span>
    </div>
  );
}

function usePanelPosition({
  container,
  getAnchor,
  panelRef,
}: {
  container: HTMLElement;
  getAnchor: () => DOMRect | null;
  panelRef: RefObject<HTMLDivElement | null>;
}) {
  const [position, setPosition] = useState<{
    left: number;
    top: number;
  } | null>(null);
  const getAnchorRef = useRef(getAnchor);
  getAnchorRef.current = getAnchor;

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const place = () => {
      const anchor = getAnchorRef.current();
      if (!anchor) return;
      const fixed = container === document.body;
      const box = fixed
        ? {
            left: 0,
            top: 0,
            right: window.innerWidth,
            bottom: window.innerHeight,
          }
        : container.getBoundingClientRect();
      const gap = 8;
      const { offsetHeight: height, offsetWidth: width } = panel;
      const below = anchor.bottom + gap;
      const top =
        below + height <= box.bottom - gap
          ? below
          : Math.max(box.top + gap, anchor.top - height - gap);
      const left = Math.max(
        box.left + gap,
        Math.min(anchor.left, box.right - width - gap),
      );
      setPosition({
        left: fixed ? left : left - box.left,
        top: fixed ? top : top - box.top,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    observer.observe(panel);
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [container, panelRef]);

  return position;
}

// The preview shows the words, not the markdown that formats them.
function toPlainText(markdown: string) {
  return markdown
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/gu, "$1")
    .replace(/\*\*([^*\n]+)\*\*/gu, "$1")
    .replace(/(^|[^*\w])\*([^*\n]+)\*(?!\w)/gu, "$1$2")
    .trim();
}
