"use client";

import { isThreadStarred } from "@/app/(app)/[emailAccountId]/mail/star-state";
import * as React from "react";
import { Loader2Icon, MessageSquarePlusIcon, UsersIcon } from "lucide-react";
import { useTheme } from "next-themes";
import { THEME_OPTIONS } from "@/components/theme-options";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import { buildMailCommandPalette } from "@/app/(app)/[emailAccountId]/mail/mail-command-palette";
import { buildSnoozeCommandPalette } from "@/app/(app)/[emailAccountId]/mail/snooze-command-palette";
import { useSnoozeDateParser } from "@/hooks/useSnoozeDateParser";
import { ShortcutsDialog } from "@/app/(app)/[emailAccountId]/mail/ShortcutsDialog";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "@/components/ui/command";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import {
  commandPaletteOpenAtom,
  feedbackDialogOpenAtom,
  mailCommandContextAtom,
  senderCommandContextAtom,
  shortcutsDialogOpenAtom,
} from "@/store/command-palette";
import type {
  MailCommandContext,
  SenderCommandContext,
} from "@/store/command-palette";
import { useDisplayedEmail } from "@/hooks/useDisplayedEmail";
import { useCommandPaletteCommands } from "@/hooks/useCommandPaletteCommands";
import { fuzzySearch } from "@/lib/commands/fuzzy-search";
import type { Command, CommandSection } from "@/lib/commands/types";
import { ShortcutsProvider } from "@/lib/shortcuts/ShortcutsProvider";
import { useShortcuts } from "@/lib/shortcuts/useShortcuts";
import {
  buildShortcutPaletteCommands,
  MAIL_SHORTCUT_SCOPES,
  type ShortcutHandlers,
} from "@/lib/shortcuts/registry";
import { useThread } from "@/hooks/useThread";
import { useOptionalMailClient } from "@inboxzero/mail-react/MailEngineProvider";
import { mutationPayloadToChange } from "@/utils/mail-engine/mutation-change";
import { submitConversationChange } from "@/utils/mail-engine/submit-conversations";
import { admissionRejectionCopy } from "@/utils/mail-engine/admission-notice";
import { AccountCommandList } from "@/components/AccountCommandList";
import { toastError, toastSuccess } from "@/components/Toast";
import { trackMailAction } from "@/utils/analytics/mail-usage";
import { useNotificationsQuiet } from "@/hooks/useNotificationsQuiet";
import {
  buildQuietPageCommands,
  buildQuietRootCommand,
} from "@/utils/web-notifications/quiet-command-palette";
import { formatQuietUntil } from "@/utils/web-notifications/quiet-presets";
import {
  pauseNotificationsUntil,
  resumeNotifications,
} from "@/utils/web-notifications/preference";

const SECTION_ORDER: CommandSection[] = [
  "actions",
  "navigation",
  "rules",
  "accounts",
  "settings",
];

const SECTION_LABELS: Record<CommandSection, string> = {
  actions: "Actions",
  navigation: "Navigation",
  rules: "Rules",
  accounts: "Switch Account",
  settings: "Settings",
};

type PalettePage = "root" | "snooze" | "quiet" | "accounts";

const EMPTY_MESSAGES: Record<PalettePage, string> = {
  root: "No results found.",
  snooze: "Try a date like tomorrow at 3pm.",
  quiet: "Try a time like 6pm or tomorrow at 9am, up to 30 days ahead.",
  accounts: "No results found.",
};

/** Still shown in ⌘K when a conversation is selected and mail actions take over. */
const ALWAYS_VISIBLE_SHORTCUT_COMMANDS = new Set(["compose", "help"]);

// Mounted app-wide. It enables the mail scope everywhere so the side-panel email
// viewer keeps its triage keys on any page. That doesn't collide with the mail
// route's own bindings: these handlers are only defined when the side panel has a
// thread (`side-panel-thread-id`), which the mail list never sets — and the mail
// screen in turn stands down while the side panel is open.
export function CommandK() {
  return (
    <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
      <CommandPalette />
      <ShortcutsDialog />
    </ShortcutsProvider>
  );
}

function CommandPalette() {
  const mailCommandContext = useAtomValue(mailCommandContextAtom);
  const senderCommandContext = useAtomValue(senderCommandContextAtom);
  const displayedEmail = useDisplayedEmail();
  const activeMailContext = displayedEmail.threadId ? null : mailCommandContext;
  const senderContextMatchesTarget = Boolean(
    activeMailContext?.target &&
      senderCommandContext &&
      activeMailContext.target.emailAccountId ===
        senderCommandContext.emailAccountId &&
      activeMailContext.target.threadId === senderCommandContext.threadId,
  );

  return (
    <CommandPaletteContent
      displayedEmail={displayedEmail}
      mailCommandContext={activeMailContext}
      senderCommandContext={
        senderContextMatchesTarget ? senderCommandContext : null
      }
    />
  );
}

function CommandPaletteContent({
  displayedEmail,
  mailCommandContext,
  senderCommandContext,
}: {
  displayedEmail: ReturnType<typeof useDisplayedEmail>;
  mailCommandContext: MailCommandContext | null;
  senderCommandContext: SenderCommandContext | null;
}) {
  const [open, setOpen] = useAtom(commandPaletteOpenAtom);
  const setShortcutsOpen = useSetAtom(shortcutsDialogOpenAtom);
  const setFeedbackOpen = useSetAtom(feedbackDialogOpenAtom);
  const [activePage, setPage] = React.useState<PalettePage>("root");
  const [search, setSearch] = React.useState("");
  const quiet = useNotificationsQuiet();
  const page = pageStillAvailable(activePage, {
    canSnooze: Boolean(mailCommandContext?.actions.snooze),
    canPauseNotifications: quiet.canPause,
  })
    ? activePage
    : "root";
  // Loading starts as the palette opens, so the parser is usually ready by
  // the time someone types a snooze or pause time.
  const parseSnoozeDate = useSnoozeDateParser(
    open && (Boolean(mailCommandContext?.actions.snooze) || quiet.canPause),
  );
  const { setTheme } = useTheme();

  const client = useOptionalMailClient();
  const { threadId, accountId: displayedAccountId, showEmail } = displayedEmail;
  const { data: displayedThread, isLoading: isDisplayedThreadLoading } =
    useThread({
      id: threadId,
      emailAccountId: displayedAccountId ?? undefined,
    });
  const { onOpen: onOpenComposeModal } = useComposeModal();
  const { commands, isLoading } = useCommandPaletteCommands({
    includeRules: !mailCommandContext,
  });

  const shortcutHandlers: ShortcutHandlers = {
    commandPalette: () => {
      setPage("root");
      setSearch("");
      setOpen((wasOpen) => !wasOpen);
    },
    compose: onOpenComposeModal,
    help: () => setShortcutsOpen(true),
    archive: threadId
      ? async () => {
          if (displayedThread?.thread.id !== threadId || !displayedAccountId) {
            toastError({
              description: isDisplayedThreadLoading
                ? "Email is still loading"
                : "Email is unavailable",
            });
            return;
          }
          try {
            const change = mutationPayloadToChange({ kind: "archive" });
            if (!client || !change) {
              throw new Error("Mail engine is unavailable");
            }
            const { admission } = await submitConversationChange({
              accountId: displayedAccountId,
              change,
              client,
              conversationId: threadId,
            });
            if (admission.status === "rejected") {
              toastError({
                description:
                  admissionRejectionCopy(admission.code) ??
                  "Couldn't queue archiving this email",
              });
              return;
            }
            showEmail(null);
          } catch {
            toastError({
              description: "Couldn't queue archiving this email",
            });
          }
        }
      : undefined,
    star: threadId
      ? async () => {
          if (displayedThread?.thread.id !== threadId || !displayedAccountId) {
            toastError({
              description: isDisplayedThreadLoading
                ? "Email is still loading"
                : "Email is unavailable",
            });
            return;
          }
          try {
            const change = mutationPayloadToChange({
              kind: "set_starred_state",
              starred: !isThreadStarred(displayedThread.thread.messages),
            });
            if (!client || !change) {
              throw new Error("Mail engine is unavailable");
            }
            const { admission } = await submitConversationChange({
              accountId: displayedAccountId,
              change,
              client,
              conversationId: threadId,
            });
            if (admission.status === "rejected") {
              toastError({
                description:
                  admissionRejectionCopy(admission.code) ??
                  "Couldn’t update the star for this email",
              });
            }
          } catch {
            toastError({
              description: "Couldn’t update the star for this email",
            });
          }
        }
      : undefined,
    forward:
      threadId && displayedThread?.thread.id === threadId
        ? () => {
            const messageId = displayedThread.thread.messages.at(-1)?.id;
            if (!messageId) return;
            showEmail({
              threadId,
              accountId: displayedAccountId ?? undefined,
              autoOpenForwardForMessageId: messageId,
              showReplyButton: true,
            });
          }
        : undefined,
    snooze: mailCommandContext?.actions.snooze
      ? () => {
          setSearch("");
          setPage("snooze");
          setOpen(true);
        }
      : undefined,
    // While the palette is open, Escape belongs to the dialog.
    backToList: open || !threadId ? undefined : () => showEmail(null),
  };

  useShortcuts(shortcutHandlers);

  const shortcutCommands = buildShortcutPaletteCommands(shortcutHandlers);
  const mailCommands = mailCommandContext
    ? buildMailCommandPalette({
        actions: {
          archive: mailCommandContext.actions.archive,
          moveToInbox: mailCommandContext.actions.moveToInbox,
          forward: mailCommandContext.actions.forward,
          label: mailCommandContext.actions.label,
          star: mailCommandContext.actions.star,
          markRead: mailCommandContext.actions.markRead,
          markSpam: mailCommandContext.actions.markSpam,
          markUnread: mailCommandContext.actions.markUnread,
          move: mailCommandContext.actions.move,
          openSnooze: mailCommandContext.actions.snooze
            ? () => setPage("snooze")
            : undefined,
          trash: mailCommandContext.actions.trash,
          openExternal: mailCommandContext.actions.openExternal,
          translate: mailCommandContext.actions.translate,
          comment: mailCommandContext.actions.comment,
          toggleAutoArchive: senderCommandContext?.toggleAutoArchive,
          unsubscribe: senderCommandContext?.unsubscribe,
        },
        allStarred: mailCommandContext.allStarred,
        hasRead: mailCommandContext.hasRead,
        hasUnread: mailCommandContext.hasUnread,
        isAutoArchived: senderCommandContext?.isAutoArchived,
        isAutoArchiveDisabled: senderCommandContext?.isAutoArchiveDisabled,
        isUnsubscribeDisabled: senderCommandContext?.isUnsubscribeDisabled,
        unsubscribeLabel: senderCommandContext?.unsubscribeLabel,
        openExternalLabel: mailCommandContext.openExternalLabel,
        targetCount: mailCommandContext.targetCount,
      })
    : [];

  let allCommands: Command[];
  if (page === "snooze" && mailCommandContext?.actions.snooze) {
    allCommands = buildSnoozeCommandPalette({
      onSnooze: mailCommandContext.actions.snooze,
      parseDate: parseSnoozeDate,
      query: search,
    });
  } else if (page === "quiet") {
    allCommands = buildQuietPageCommands({
      parseDate: parseSnoozeDate,
      query: search,
      pause: (until) => {
        pauseNotificationsUntil(until.getTime());
        toastSuccess({
          description: `Notifications paused until ${formatQuietUntil(until, new Date())}`,
        });
      },
    });
  } else {
    const actionCommands = mailCommandContext
      ? [
          ...mailCommands,
          ...shortcutCommands.filter((command) =>
            ALWAYS_VISIBLE_SHORTCUT_COMMANDS.has(command.id),
          ),
        ]
      : shortcutCommands;
    const themeCommands: Command[] = THEME_OPTIONS.map(
      ({ value, label, icon }) => ({
        id: `theme-${value}`,
        label: `Set Theme: ${label}`,
        icon,
        section: "settings",
        keywords: ["switch", "theme", "appearance", "mode", value],
        action: () => setTheme(value),
      }),
    );
    allCommands = [
      ...actionCommands,
      {
        id: "switch-accounts",
        label: "Switch accounts",
        icon: UsersIcon,
        section: "accounts",
        keywords: ["switch", "accounts", "email", "inbox"],
        closeOnSelect: false,
        action: () => setPage("accounts"),
      },
      ...commands,
      ...themeCommands,
    ];
    if (quiet.canPause)
      allCommands.push(
        buildQuietRootCommand({
          quietUntilMs: quiet.quietUntilMs,
          openPausePage: () => {
            setSearch("");
            setPage("quiet");
          },
          resume: () => {
            resumeNotifications();
            toastSuccess({ description: "Notifications resumed" });
          },
        }),
      );
    allCommands.push({
      id: "send-feedback",
      label: "Send feedback",
      icon: MessageSquarePlusIcon,
      section: "settings",
      keywords: ["feedback", "bug", "report", "suggestion", "idea"],
      action: () => setFeedbackOpen(true),
    });
  }

  const filteredCommands =
    page === "snooze" || page === "quiet" || !search.trim()
      ? allCommands
      : fuzzySearch(search, allCommands);
  const groupedCommands = groupCommands(filteredCommands);

  const executeCommand = (command: Command) => {
    if (command.disabled) return;
    setSearch("");
    if (command.closeOnSelect !== false) {
      setOpen(false);
      setPage("root");
    }
    command.action();
    trackMailAction({ action: command.id, source: "palette" });
  };

  const handleOpenChange = (isOpen: boolean) => {
    setOpen(isOpen);
    if (!isOpen) {
      setPage("root");
      setSearch("");
    }
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      onEscapeKeyDown={(event) => {
        if (page === "root") return;
        event.preventDefault();
        setPage("root");
        setSearch("");
      }}
      commandProps={{
        // Disable cmdk's built-in filter since we use custom fuzzy search.
        shouldFilter: false,
        onKeyDown: (event: React.KeyboardEvent<HTMLDivElement>) => {
          if (event.key !== "Escape") event.stopPropagation();
        },
      }}
    >
      <CommandInput
        key={page}
        autoFocus
        placeholder={
          {
            root: "Type a command or search...",
            snooze: "When should it return? Try Friday at 3pm",
            quiet: "Pause until when? Try 6pm or Monday 9am",
            accounts: "Search accounts...",
          }[page]
        }
        value={search}
        onValueChange={setSearch}
      />
      <CommandList>
        {page === "accounts" ? (
          <AccountCommandList
            search={search}
            onClose={() => handleOpenChange(false)}
            onBack={() => {
              setPage("root");
              setSearch("");
            }}
          />
        ) : isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2Icon className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <CommandEmpty>{EMPTY_MESSAGES[page]}</CommandEmpty>
            {SECTION_ORDER.map((section, index) => {
              const sectionCommands = groupedCommands[section];
              if (sectionCommands.length === 0) return null;

              const showSeparator =
                index > 0 &&
                SECTION_ORDER.slice(0, index).some(
                  (s) => groupedCommands[s].length > 0,
                );

              return (
                <React.Fragment key={section}>
                  {showSeparator && <CommandSeparator />}
                  <CommandGroup
                    heading={sectionHeading(
                      section,
                      page,
                      mailCommandContext?.account,
                    )}
                  >
                    {sectionCommands.map((command) => (
                      <CommandItem
                        key={command.id}
                        value={`${command.id} ${command.label} ${command.keywords?.join(" ") || ""}`}
                        disabled={command.disabled}
                        onSelect={() => executeCommand(command)}
                      >
                        {command.icon && (
                          <command.icon className="mr-2 h-4 w-4" />
                        )}
                        <span className="flex-1">{command.label}</span>
                        {command.description && (
                          <span className="ml-3 shrink-0 text-xs text-muted-foreground">
                            {command.description}
                          </span>
                        )}
                        {command.account && (
                          <span className="ml-3 min-w-0 truncate text-xs text-muted-foreground">
                            {command.account}
                          </span>
                        )}
                        {command.shortcut && (
                          <CommandShortcut>{command.shortcut}</CommandShortcut>
                        )}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                </React.Fragment>
              );
            })}
          </>
        )}
      </CommandList>
    </CommandDialog>
  );
}

/** Across accounts, the mail actions' heading says which account they run in. */
function sectionHeading(
  section: CommandSection,
  page: PalettePage,
  account: string | undefined,
) {
  const pageHeading = { snooze: "Snooze until", quiet: "Pause notifications" };
  const heading =
    section === "actions" && (page === "snooze" || page === "quiet")
      ? pageHeading[page]
      : SECTION_LABELS[section];
  return section === "actions" && account ? `${heading} · ${account}` : heading;
}

function groupCommands(commands: Command[]) {
  const groups: Record<CommandSection, Command[]> = {
    actions: [],
    navigation: [],
    rules: [],
    accounts: [],
    settings: [],
  };

  for (const command of commands) groups[command.section].push(command);

  return groups;
}

// A page whose action went away while open (mail deselected, notifications
// turned off in another tab) falls back to the first page.
function pageStillAvailable(
  page: PalettePage,
  available: { canSnooze: boolean; canPauseNotifications: boolean },
) {
  if (page === "snooze") return available.canSnooze;
  if (page === "quiet") return available.canPauseNotifications;
  return true;
}
