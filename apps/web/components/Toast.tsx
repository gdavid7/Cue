import { Check, CircleAlert, Loader2, X } from "lucide-react";
import { Toaster as SonnerToaster, toast } from "sonner";
import { Kbd } from "@/components/Kbd";
import { cn } from "@/utils";

// The app's primary token is near-black in light mode and near-white in dark,
// so links and rails use the mail palette's blue explicitly.
const ACCENT_TEXT = "text-blue-600 dark:text-blue-400";
// Key hints mean nothing without a keyboard.
const HIDE_ON_TOUCH = "[@media(pointer:coarse)]:hidden";

export function toastSuccess(options: {
  title?: string;
  description: string;
  id?: string;
}) {
  return toast.success(options.title || options.description, {
    description: options.title ? options.description : undefined,
    id: options.id,
  });
}

/** A success that made something elsewhere, with a link to open it. */
export function toastSuccessWithLink(options: {
  description: string;
  link: { label: string; href: string } | null;
  id?: string | number;
}) {
  const { link } = options;
  return toast.success(options.description, {
    id: options.id,
    action: link
      ? {
          label: link.label,
          onClick: () => window.open(link.href, "_blank", "noopener"),
        }
      : undefined,
  });
}

export function toastError(options: {
  title?: string;
  description: string;
  id?: string | number;
  duration?: number;
  action?: { label: string; onClick: () => void };
}) {
  return toast.error(options.title || options.description, {
    description: options.title ? options.description : undefined,
    duration: options.duration ?? 10_000,
    id: options.id,
    action: options.action,
  });
}

export function toastLoading(description: string) {
  return toast.loading(description);
}

export function toastInfo(options: {
  title: string;
  description: string;
  duration?: number;
}) {
  return toast(options.title, {
    description: options.description,
    duration: options.duration,
  });
}

type ToastUndoHandler = () => void | Promise<void>;

let latestToastUndo: { id: string; onUndo: ToastUndoHandler } | null = null;

export function toastUndo(options: {
  id?: string;
  message: string;
  shortcut?: string;
  duration?: number;
  onUndo: ToastUndoHandler;
}) {
  const id = options.id ?? "undo";
  const release = registerUndo(id, options.onUndo);
  return toast.success(options.message, {
    id,
    duration: options.duration,
    onAutoClose: release,
    onDismiss: release,
    action: undoAction(options.onUndo, options.shortcut),
  });
}

/**
 * The send's one toast, from hold to delivery. While the send is held it offers
 * Undo and drains a bar over the hold; without `hold` it only says it's sending.
 */
export function toastSending(options: {
  id: string;
  hold?: { durationMs: number; shortcut?: string; onUndo: ToastUndoHandler };
}) {
  const { id, hold } = options;
  const release = hold ? registerUndo(id, hold.onUndo) : () => {};
  return toast(
    hold ? <SendingTitle durationMs={hold.durationMs} /> : "Sending…",
    {
      id,
      icon: null,
      description: undefined,
      duration: Number.POSITIVE_INFINITY,
      onAutoClose: release,
      onDismiss: release,
      action: hold ? undoAction(hold.onUndo, hold.shortcut) : undefined,
    },
  );
}

export function toastSent(id: string) {
  releaseUndo(id);
  return toast.success("Sent", {
    id,
    icon: <Check className={cn("size-4", ACCENT_TEXT)} />,
    description: undefined,
    duration: 2000,
    action: undefined,
  });
}

export function toastSendUndone(id: string) {
  releaseUndo(id);
  return toast.success("Send undone. Draft restored.", {
    id,
    icon: null,
    description: undefined,
    duration: 4000,
    action: undefined,
  });
}

export function toastSendFailed(options: { id: string; onRetry: () => void }) {
  releaseUndo(options.id);
  return toast.error("Couldn't send", {
    id: options.id,
    description: undefined,
    duration: Number.POSITIVE_INFINITY,
    action: { label: "Retry", onClick: options.onRetry },
  });
}

export async function undoLatestToast() {
  const current = latestToastUndo;
  if (!current) return false;
  latestToastUndo = null;
  toast.dismiss(current.id);
  await current.onUndo();
  return true;
}

export function Toaster() {
  return (
    <SonnerToaster
      position="bottom-left"
      // Desktop clears the mail sidebar and phones clear the tab bar; the
      // values live in globals.css because they depend on which shell is up.
      offset={{
        left: "var(--toast-offset-left)",
        bottom: "var(--toast-offset-bottom)",
      }}
      mobileOffset={{
        left: 16,
        right: 16,
        bottom: "var(--toast-offset-bottom)",
      }}
      closeButton
      visibleToasts={9}
      gap={8}
      icons={{
        success: null,
        info: null,
        warning: <CircleAlert className="size-4 text-amber-500" />,
        error: <CircleAlert className="size-4 text-destructive" />,
        loading: <Loader2 className={cn("size-4 animate-spin", ACCENT_TEXT)} />,
        close: <X className="size-4" />,
      }}
      toastOptions={{
        unstyled: true,
        classNames: {
          toast:
            "relative flex w-full items-center gap-3 overflow-hidden rounded-lg border border-border bg-popover py-3 pl-4 pr-2 text-popover-foreground shadow-lg before:absolute before:inset-y-0 before:left-0 before:w-[3px] before:bg-blue-500 data-[type=error]:before:bg-destructive data-[type=warning]:before:bg-amber-500",
          icon: "relative flex size-4 shrink-0 items-center justify-center",
          content: "min-w-0 flex-1",
          title: "text-sm font-medium leading-5",
          description: "mt-0.5 text-sm leading-5 text-muted-foreground",
          actionButton: cn(
            "inline-flex shrink-0 items-center rounded px-1.5 py-1 text-sm [@media(pointer:coarse)]:min-h-11 [@media(pointer:coarse)]:px-3 font-medium hover:bg-blue-600/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            ACCENT_TEXT,
          ),
          cancelButton:
            "inline-flex shrink-0 items-center rounded px-1.5 py-1 text-sm font-medium text-muted-foreground hover:bg-muted",
          closeButton:
            "order-last inline-flex shrink-0 items-center rounded p-1.5 text-muted-foreground/70 hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        },
      }}
    />
  );
}

function registerUndo(id: string, onUndo: ToastUndoHandler) {
  latestToastUndo = { id, onUndo };
  return () => {
    if (latestToastUndo?.onUndo === onUndo) latestToastUndo = null;
  };
}

function releaseUndo(id: string) {
  if (latestToastUndo?.id === id) latestToastUndo = null;
}

function undoAction(onUndo: ToastUndoHandler, shortcut?: string) {
  return {
    label: (
      <>
        Undo
        {shortcut && (
          <Kbd className={cn("ml-1.5", ACCENT_TEXT, HIDE_ON_TOUCH)}>
            {shortcut}
          </Kbd>
        )}
      </>
    ),
    onClick: onUndo,
  };
}

function SendingTitle({ durationMs }: { durationMs: number }) {
  return (
    <>
      <span className="motion-reduce:hidden">Sending…</span>
      <span className="hidden motion-reduce:inline">
        Sending in {Math.ceil(durationMs / 1000)}s
      </span>
      {/* Positioned against the toast itself, so it runs along its bottom edge. */}
      <span
        aria-hidden
        className="absolute inset-x-0 bottom-0 h-0.5 origin-left bg-blue-500/70 motion-reduce:hidden"
        style={{ animation: `toast-drain ${durationMs}ms linear forwards` }}
      />
    </>
  );
}
