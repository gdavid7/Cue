"use client";

import { useCallback, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import type {
  EmailEditorHandle,
  EmailEditorSlashTrigger,
} from "@inboxzero/email-editor/web";
import { SnippetForm } from "@/components/snippets/SnippetForm";
import {
  SnippetPicker,
  type SnippetPickerRef,
} from "@/components/snippets/SnippetPicker";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useSnippets } from "@/hooks/useSnippets";
import {
  snippetContentToHtml,
  snippetVariablesFromRecipient,
} from "@/utils/snippets/expand-snippet";
import {
  normalizeSnippetQuery,
  type SnippetMatchItem,
} from "@/utils/snippets/match-snippets";
import type { CreateSnippetBody } from "@/utils/actions/snippet.validation";

const EMPTY_SNIPPETS: SnippetMatchItem[] = [];

export function useComposeSnippets({
  editorRef,
  onAskCue,
  onShareFreeTimes,
  to,
}: {
  editorRef: RefObject<EmailEditorHandle | null>;
  // Opens Cue at the caret with what was typed after "/".
  onAskCue?: (text: string) => void;
  onShareFreeTimes?: () => void;
  to?: string;
}) {
  const { data, mutate } = useSnippets();
  const snippets = data?.snippets ?? EMPTY_SNIPPETS;
  const toRef = useRef(to);
  toRef.current = to;
  const [formState, setFormState] = useState<{
    defaults?: Partial<CreateSnippetBody>;
    insertOnCreate: boolean;
    open: boolean;
  }>({ open: false, insertOnCreate: false });
  const closeForm = useCallback(() => {
    setFormState({ insertOnCreate: false, open: false });
  }, []);

  const [slashTrigger, setSlashTrigger] =
    useState<EmailEditorSlashTrigger | null>(null);
  const slashPickerRef = useRef<SnippetPickerRef>(null);

  const snippetHtml = useCallback(
    (snippet: SnippetMatchItem) =>
      snippetContentToHtml(
        snippet.content,
        snippetVariablesFromRecipient(toRef.current),
      ),
    [],
  );
  const insertSnippet = useCallback(
    (snippet: SnippetMatchItem) => {
      editorRef.current?.insertHtml(snippetHtml(snippet));
    },
    [editorRef, snippetHtml],
  );

  const openCreate = useCallback(
    (
      defaults?: Partial<CreateSnippetBody>,
      options?: { insertOnCreate?: boolean },
    ) => {
      setFormState({
        defaults: {
          content:
            defaults?.content ?? editorRef.current?.getSelectedText() ?? "",
          shortcut: defaults?.shortcut ?? "",
        },
        insertOnCreate: options?.insertOnCreate ?? false,
        open: true,
      });
    },
    [editorRef],
  );
  const onSlashKeyDown = useCallback(
    (event: KeyboardEvent) =>
      slashPickerRef.current?.onKeyDown({ event }) ?? false,
    [],
  );

  const toolbar = (
    <>
      {slashTrigger &&
        createPortal(
          <div
            className="fixed z-[100]"
            style={{
              left: slashTrigger.rect.left,
              top: slashTrigger.rect.bottom + 4,
            }}
          >
            <SnippetPicker
              onSelectAsk={
                onAskCue
                  ? () => {
                      editorRef.current?.replaceSlashTrigger("");
                      onAskCue(slashTrigger.query);
                    }
                  : undefined
              }
              onSelectFreeTimes={
                onShareFreeTimes
                  ? () => {
                      editorRef.current?.replaceSlashTrigger("");
                      onShareFreeTimes();
                    }
                  : undefined
              }
              onSelectCreate={() => {
                editorRef.current?.replaceSlashTrigger("");
                openCreate(
                  { shortcut: normalizeSnippetQuery(slashTrigger.query) },
                  { insertOnCreate: true },
                );
              }}
              onSelectSnippet={(snippet) => {
                editorRef.current?.replaceSlashTrigger(snippetHtml(snippet));
              }}
              query={slashTrigger.query}
              ref={slashPickerRef}
              snippets={snippets}
            />
          </div>,
          document.body,
        )}
      <Dialog
        onOpenChange={(open) => {
          if (!open) closeForm();
        }}
        open={formState.open}
      >
        <DialogContent
          className="max-w-lg"
          data-snippet-picker=""
          onEscapeKeyDown={(event) => event.stopPropagation()}
        >
          <DialogHeader>
            <DialogTitle>Save snippet</DialogTitle>
            <DialogDescription className="sr-only">
              Save a reusable snippet.
            </DialogDescription>
          </DialogHeader>
          <SnippetForm
            closeDialog={closeForm}
            initialValues={formState.defaults}
            onCreated={(snippet) => {
              if (formState.insertOnCreate) insertSnippet(snippet);
            }}
            refetch={() => {
              mutate();
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );

  return {
    onSlashKeyDown,
    onSlashTrigger: setSlashTrigger,
    toolbar,
  };
}
