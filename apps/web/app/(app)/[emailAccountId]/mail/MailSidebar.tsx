"use client";

import {
  type ComponentProps,
  type DragEvent,
  type FormEvent,
  type MouseEvent,
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { getMailSidebarRowPresentation } from "@inboxzero/mail-ui/MailSidebarRow";
import {
  ArchiveIcon,
  BellIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  AlarmClockIcon,
  Clock3Icon,
  FileIcon,
  FlagIcon,
  FolderIcon,
  InboxIcon,
  LayersIcon,
  type LucideIcon,
  MailsIcon,
  MegaphoneIcon,
  MessagesSquareIcon,
  PaperclipIcon,
  PenLineIcon,
  PlusIcon,
  SendIcon,
  ShieldAlertIcon,
  SparklesIcon,
  StarIcon,
  SunIcon,
  TagIcon,
  Trash2Icon,
  UserIcon,
  Users2Icon,
} from "lucide-react";
import type { MailboxLabelCount } from "@/utils/mail-engine/label-count-targets";
import { useMailEngineStarting } from "@/utils/mail-engine/MailEngineHost";
import { Tooltip as ShortcutTooltip } from "@/components/Tooltip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { SidebarTrigger } from "@/components/ui/sidebar";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { EmailLabel } from "@/providers/email-label-types";
import { GmailLabel } from "@/utils/gmail/label";
import { cn } from "@/utils";
import { parseMailPath } from "@/utils/mail-url";
import type { OutlookFolder } from "@/utils/outlook/folders";
import { OUTLOOK_INBOX_SECTIONS } from "@/utils/outlook/inbox-sections";
import { getLabelTree, type SidebarLabel } from "./label-tree";
import { showMailView } from "./show-mail-view";
import type { MailAppLink } from "./use-mail-app-links";
import {
  isSidebarRowActive,
  type PendingNavigation,
  usePendingNavigation,
} from "./pending-navigation";
import { splitLabelsByListVisibility } from "./label-visibility";
import { getMailSidebarFolders } from "./outlook-folder-list";
import {
  isMailDragEvent,
  MAIL_DRAG_TYPE,
  type MailDrag,
  useDragPresence,
  useMailDrag,
  useSetMailDrag,
} from "./mail-drag";
import { resolveSidebarDrop, type SidebarDropTarget } from "./sidebar-drop";
import {
  MailboxItemContextMenu,
  type MailboxItemColorOption,
  type MailboxItem,
  type MailboxItemEdit,
} from "./MailboxItemContextMenu";

/** Where a sidebar row navigates. Mirrors the mail page's `?type=` query shape. */
export type MailNavTarget =
  | { kind: "type"; type: string }
  | { kind: "label"; labelId: string }
  | { kind: "folder"; folderId: string };

export type MailSidebarProps = {
  /** `?type=` of the current view — `inbox` when nothing is selected. */
  activeType: string | null;
  /** `?labelId=` of the current view, when a user label is open. */
  activeLabelId: string | null;
  /** `?folderId=` of the current view, when an Outlook folder is open. */
  activeFolderId: string | null;
  /** Builds the href for a row so the sidebar never owns routing. */
  hrefFor: (target: MailNavTarget) => string;
  labels: EmailLabel[];
  folders: OutlookFolder[];
  /** Keyed by provider label/folder id. Arrives after first paint; may be empty. */
  countsById: Map<string, MailboxLabelCount>;
  categories: MailCategory[];
  categoryHeading: string;
  labelsHeading: string;
  labelSingular: string;
  onCompose: () => void;
  onCreateLabel: (name: string) => void;
  onEditMailboxItem: (edit: MailboxItemEdit) => Promise<boolean>;
  onDeleteMailboxItem: (item: MailboxItem) => Promise<boolean>;
  labelEditMode: "color" | "name-and-color";
  labelColorOptions: readonly MailboxItemColorOption[];
  /** Gmail lets a label be hidden from the label and message lists. */
  supportsLabelVisibility?: boolean;
  /** Gmail has an Important view; Outlook has no matching folder. */
  supportsImportant?: boolean;
  /** Hide the categories group behind a toggle, collapsed by default. */
  collapsibleCategories?: boolean;
  /** Icon-only rail: rows shrink to their icon and names move into tooltips. */
  collapsed?: boolean;
  footer?: ReactNode;
  /** Connected apps, listed under the labels. */
  connectors?: ReactNode;
  unified?: boolean;
  /** Offered above a single account's inbox when there are inboxes to combine. */
  allInboxesHref?: string;
  /** Today's briefing, which lives outside the mail view. */
  /** Undefined hides Today; null keeps its place until there is an account. */
  todayHref?: string | null;
  /** The pointer or focus reached the Today row, so it may well open next. */
  onTodayIntent?: () => void;
  /** The pointer or focus left the Today row. */
  onTodayIntentEnd?: () => void;
  /** The app's other places, such as Chat and Rules, above the footer. */
  appLinks?: MailAppLink[];
  /** The app's rarer tools, such as Unsubscribe, behind a Tools toggle. */
  toolLinks?: MailAppLink[];
  /** False where something else opens and closes the sidebar, like a sheet. */
  showSidebarToggle?: boolean;
  /** Each account's own labels and folders, shown in their place in All inboxes. */
  accountSections?: ReactNode;
  /**
   * The account whose labels these rows are, set where dropped mail can be
   * labelled the way the label picker labels it.
   */
  dropAccountId?: string;
  className?: string;
};

type SystemItem = {
  name: string;
  type: string;
  /** Dragged mail dropped on the row goes here. */
  dropTarget?: SidebarDropTarget;
  /** null means the row never shows a count (a "sent unread" number is noise). */
  countId: string | null;
  Icon: LucideIcon;
  /** Shown only for accounts with an Important view. */
  importantOnly?: boolean;
};

export const MAIL_SCHEDULED_TYPE = "scheduled";
export const MAIL_SNOOZED_TYPE = "snoozed";
/** Every attachment on the mail stored on this device. */
export const MAIL_FILES_TYPE = "files";
/** Mailboxes All inboxes merges from every included account's local mail. */
export const ALL_INBOXES_MAILBOX_TYPES: ReadonlySet<string> = new Set([
  "draft",
  "sent",
  "starred",
]);
/** Every view All inboxes has beyond its inbox. */
export const ALL_INBOXES_VIEW_TYPES: ReadonlySet<string> = new Set([
  ...ALL_INBOXES_MAILBOX_TYPES,
  MAIL_SNOOZED_TYPE,
  MAIL_SCHEDULED_TYPE,
  MAIL_FILES_TYPE,
]);

/** Visited often enough to sit beside the inbox. */
const PRIMARY_MAILBOX_ITEMS: SystemItem[] = [
  { name: "Drafts", type: "draft", countId: "DRAFT", Icon: FileIcon },
  { name: "Sent", type: "sent", countId: null, Icon: SendIcon },
  { name: "Files", type: MAIL_FILES_TYPE, countId: null, Icon: PaperclipIcon },
];

/** The rest of the mailbox. Visited rarely enough to stay behind More. */
const MORE_MAILBOX_ITEMS: SystemItem[] = [
  {
    name: "Archived",
    type: "archive",
    countId: null,
    Icon: ArchiveIcon,
    dropTarget: { kind: "archive" },
  },
  {
    name: "Starred",
    type: "starred",
    countId: null,
    Icon: StarIcon,
    dropTarget: { kind: "starred" },
  },
  {
    name: "Important",
    type: "important",
    countId: null,
    Icon: FlagIcon,
    importantOnly: true,
  },
  {
    name: "Snoozed",
    type: MAIL_SNOOZED_TYPE,
    countId: null,
    Icon: AlarmClockIcon,
  },
  {
    name: "Scheduled",
    type: MAIL_SCHEDULED_TYPE,
    countId: null,
    Icon: Clock3Icon,
  },
  {
    name: "All Mail",
    type: "all",
    countId: null,
    Icon: MailsIcon,
    dropTarget: { kind: "archive" },
  },
  {
    name: "Spam",
    type: "spam",
    countId: null,
    Icon: ShieldAlertIcon,
    dropTarget: { kind: "spam" },
  },
  {
    name: "Trash",
    type: "trash",
    countId: null,
    Icon: Trash2Icon,
    dropTarget: { kind: "trash" },
  },
];

/** The display name of a `?type=` mailbox view, such as "Sent" for `sent`. */
export function getMailboxName(type: string): string | undefined {
  return [
    ...PRIMARY_MAILBOX_ITEMS,
    ...MORE_MAILBOX_ITEMS,
    ...MAIL_CATEGORIES,
    ...OUTLOOK_INBOX_SECTIONS,
  ].find((item) => item.type === type)?.name;
}

export type MailCategory = {
  name: string;
  type: string;
  Icon: LucideIcon;
};

export const MAIL_CATEGORIES: MailCategory[] = [
  {
    name: "Personal",
    type: GmailLabel.PERSONAL,
    Icon: UserIcon,
  },
  {
    name: "Social",
    type: GmailLabel.SOCIAL,
    Icon: Users2Icon,
  },
  {
    name: "Updates",
    type: GmailLabel.UPDATES,
    Icon: BellIcon,
  },
  {
    name: "Forums",
    type: GmailLabel.FORUMS,
    Icon: MessagesSquareIcon,
  },
  {
    name: "Promotions",
    type: GmailLabel.PROMOTIONS,
    Icon: MegaphoneIcon,
  },
];

export const OUTLOOK_INBOX_CATEGORIES: MailCategory[] =
  OUTLOOK_INBOX_SECTIONS.map((section) => ({
    ...section,
    Icon: section.type === "focused" ? SparklesIcon : InboxIcon,
  }));

export function MailSidebar(props: MailSidebarProps) {
  return (
    <PendingNavigationProvider>
      <MailSidebarContent {...props} />
    </PendingNavigationProvider>
  );
}

function MailSidebarContent({
  activeType,
  activeLabelId,
  activeFolderId,
  hrefFor,
  labels,
  folders,
  countsById,
  categories,
  categoryHeading,
  labelsHeading,
  labelSingular,
  onCompose,
  onCreateLabel,
  onEditMailboxItem,
  onDeleteMailboxItem,
  labelEditMode,
  labelColorOptions,
  supportsLabelVisibility = false,
  supportsImportant = false,
  collapsibleCategories = false,
  collapsed = false,
  footer,
  connectors,
  unified = false,
  allInboxesHref,
  todayHref,
  onTodayIntent,
  onTodayIntentEnd,
  appLinks,
  toolLinks,
  showSidebarToggle = true,
  accountSections,
  dropAccountId,
  className,
}: MailSidebarProps) {
  // Views All inboxes merges beyond its inbox, in one account's order.
  const unifiedViews = unified
    ? [...PRIMARY_MAILBOX_ITEMS, ...MORE_MAILBOX_ITEMS].filter((item) =>
        ALL_INBOXES_VIEW_TYPES.has(item.type),
      )
    : [];
  // Today across accounts, and those views, show the unified sidebar with
  // All inboxes a link.
  const unifiedMail =
    unified &&
    activeType !== "today" &&
    !unifiedViews.some((item) => item.type === activeType);
  const isCategoryActive =
    !activeLabelId &&
    !activeFolderId &&
    categories.some((category) => category.type === activeType);
  const [showCategories, setShowCategories] = useState(isCategoryActive);
  // Nothing in the rail can toggle a group, so there a group follows the open
  // view rather than a stored choice, which would otherwise be a one-way door.
  // The expanded sidebar keeps whatever the user chose.
  const showCategoryRows =
    !collapsibleCategories || (collapsed ? isCategoryActive : showCategories);

  const isTypeActive = (type: string) =>
    !activeLabelId && !activeFolderId && activeType === type;
  const moreMailboxItems = MORE_MAILBOX_ITEMS.filter(
    (item) => supportsImportant || !item.importantOnly,
  );
  const isMoreActive = moreMailboxItems.some((item) => isTypeActive(item.type));
  const [storedShowMailboxes, setShowMailboxes] = useStoredDisclosure(
    "cue.mail-sidebar.more-open",
  );
  // Mail held over More opens it for that drag, as Gmail does, so Trash and
  // Spam can be reached without letting go. Only after a pause: opening as
  // the pointer passes would push the labels below out from under it.
  const drag = useMailDrag();
  const [moreRevealedFor, setMoreRevealedFor] = useState<MailDrag | null>(null);
  const dragRevealsMore = drag !== null && moreRevealedFor === drag;
  const revealTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelReveal = () => {
    if (revealTimer.current) clearTimeout(revealTimer.current);
    revealTimer.current = null;
  };
  const overMore = useDragPresence(drag, (present) => {
    if (!present) return cancelReveal();
    if (revealTimer.current || !drag) return;
    revealTimer.current = setTimeout(() => {
      revealTimer.current = null;
      setMoreRevealedFor(drag);
    }, MORE_REVEAL_DELAY_MS);
  });
  // The toggle button inside the heading takes the pointer too, so each
  // dragover counts, not just the heading's own enter.
  const holdOverMore = drag
    ? {
        onDragEnter: (event: DragEvent) => {
          if (isMailDragEvent(event.dataTransfer)) overMore.enter();
        },
        onDragOver: (event: DragEvent) => {
          if (isMailDragEvent(event.dataTransfer)) overMore.over();
        },
        onDragLeave: (event: DragEvent) => {
          if (isMailDragEvent(event.dataTransfer)) overMore.leave();
        },
      }
    : undefined;
  useEffect(() => {
    if (drag || !revealTimer.current) return;
    clearTimeout(revealTimer.current);
    revealTimer.current = null;
  }, [drag]);
  useEffect(
    () => () => {
      if (revealTimer.current) clearTimeout(revealTimer.current);
    },
    [],
  );
  // The open view's own row is never hidden behind a closed group.
  const showMailboxes = storedShowMailboxes || isMoreActive || dragRevealsMore;
  const showMailboxRows = collapsed ? isMoreActive : showMailboxes;
  const [showTools, setShowTools] = useStoredDisclosure(
    "cue.mail-sidebar.tools-open",
  );

  useEffect(() => {
    if (isCategoryActive) setShowCategories(true);
  }, [isCategoryActive]);

  useEffect(() => {
    if (isMoreActive) setShowMailboxes(true);
  }, [isMoreActive, setShowMailboxes]);

  return (
    <aside
      className={cn(
        "flex w-[236px] shrink-0 flex-col overflow-hidden border-border border-r bg-sidebar pt-3 pb-2.5",
        collapsed ? "px-1.5" : "px-2.5",
        className,
      )}
    >
      {/* Collapsed, the toggle moves beside the traffic lights (`MailTitlebarNav`). */}
      {!showSidebarToggle ? null : collapsed ? (
        <div data-desktop-mac-titlebar-spacer className="shrink-0" />
      ) : (
        <div className="mb-2.5 flex shrink-0 items-center justify-end">
          <SidebarTrigger
            name="left-sidebar"
            className="size-6 shrink-0 text-muted-foreground"
          />
        </div>
      )}

      <ShortcutTooltip
        shortcuts={[{ id: "compose", label: "Compose" }]}
        side={collapsed ? "right" : "bottom"}
      >
        {collapsed ? (
          <Button
            size="icon"
            onClick={onCompose}
            aria-label="Compose"
            className="mb-3.5 size-10 shrink-0 self-center rounded-xl"
          >
            <PenLineIcon className="size-4" />
          </Button>
        ) : (
          <Button
            onClick={onCompose}
            className="mb-3.5 w-full shrink-0 justify-start gap-2 rounded-xl px-3"
          >
            <PenLineIcon className="size-4 shrink-0" />
            Compose
          </Button>
        )}
      </ShortcutTooltip>

      {/* The negative margin lets the scrollbar sit in the sidebar's own
          padding, so a platform-width bar can't crowd the unread counts. */}
      <nav
        aria-label="Mailboxes"
        className="-mr-1.5 flex min-h-0 flex-1 flex-col overflow-y-auto pr-1.5 scrollbar-thin"
      >
        <div className="flex flex-col gap-px">
          {unified || allInboxesHref ? (
            <NavRow
              href={unifiedMail ? undefined : allInboxesHref}
              active={unifiedMail}
              icon={<LayersIcon className="size-4 shrink-0" />}
              name="All inboxes"
              count={null}
              collapsed={collapsed}
              // Combined, it is every account's inbox.
              dropTarget={unified ? INBOX_DROP_TARGET : undefined}
            />
          ) : null}
          {unified ? null : (
            <NavRow
              href={hrefFor({ kind: "type", type: "inbox" })}
              active={
                !activeLabelId && !activeFolderId && activeType === "inbox"
              }
              icon={<InboxIcon className="size-4 shrink-0" />}
              name="Inbox"
              count={displayCount(countsById.get("INBOX"))}
              emphasizeCount
              collapsed={collapsed}
              dropTarget={INBOX_DROP_TARGET}
              // Off the mail screen the inbox is a route away; fetched ahead,
              // it opens without waiting on the server.
              prefetch={activeType === "today" ? true : undefined}
            />
          )}
          {todayHref !== undefined ? (
            <NavRow
              href={todayHref ?? undefined}
              active={activeType === "today"}
              icon={<SunIcon className="size-4 shrink-0" />}
              name="Today"
              count={null}
              collapsed={collapsed}
              prefetch
              onIntent={onTodayIntent}
              onIntentEnd={onTodayIntentEnd}
            />
          ) : null}
          {unifiedViews.map(({ name, type, countId, Icon, dropTarget }) => (
            <NavRow
              key={type}
              href={hrefFor({ kind: "type", type })}
              active={isTypeActive(type)}
              icon={<Icon className="size-4 shrink-0" />}
              name={name}
              count={countId ? displayCount(countsById.get(countId)) : null}
              collapsed={collapsed}
              dropTarget={dropTarget}
            />
          ))}
          {unified
            ? null
            : PRIMARY_MAILBOX_ITEMS.map(({ name, type, countId, Icon }) => (
                <NavRow
                  key={type}
                  href={hrefFor({ kind: "type", type })}
                  active={isTypeActive(type)}
                  icon={<Icon className="size-4 shrink-0" />}
                  name={name}
                  count={countId ? displayCount(countsById.get(countId)) : null}
                  collapsed={collapsed}
                />
              ))}
        </div>

        {!unified && (!collapsed || showMailboxRows) && (
          <>
            <GroupHeading
              collapsed={collapsed}
              expanded={showMailboxes}
              onToggle={() => setShowMailboxes(!showMailboxes)}
              dragHandlers={holdOverMore}
            >
              More
            </GroupHeading>
            {showMailboxRows && (
              <div
                role="group"
                aria-label="More mailboxes"
                className="flex flex-col gap-px"
              >
                {moreMailboxItems.map(
                  ({ name, type, countId, Icon, dropTarget }) => (
                    <NavRow
                      key={type}
                      href={hrefFor({ kind: "type", type })}
                      active={isTypeActive(type)}
                      icon={<Icon className="size-4 shrink-0" />}
                      name={name}
                      count={
                        countId ? displayCount(countsById.get(countId)) : null
                      }
                      collapsed={collapsed}
                      dropTarget={dropTarget}
                    />
                  ),
                )}
              </div>
            )}
          </>
        )}

        {/* The rail replaces headings with a rule, so an empty group would
            leave a stray line behind. */}
        {!unified &&
          categories.length > 0 &&
          (!collapsed || showCategoryRows) && (
            <>
              <GroupHeading
                collapsed={collapsed}
                expanded={collapsibleCategories ? showCategories : undefined}
                onToggle={
                  collapsibleCategories
                    ? () => setShowCategories((open) => !open)
                    : undefined
                }
              >
                {categoryHeading}
              </GroupHeading>
              {showCategoryRows && (
                <div
                  role="group"
                  aria-label={categoryHeading}
                  className="flex flex-col gap-px"
                >
                  {categories.map(({ name, type, Icon }) => (
                    <NavRow
                      key={type}
                      href={hrefFor({ kind: "type", type })}
                      active={
                        !activeLabelId && !activeFolderId && activeType === type
                      }
                      icon={<Icon className="size-3.5 shrink-0" />}
                      name={name}
                      count={null}
                      collapsed={collapsed}
                    />
                  ))}
                </div>
              )}
            </>
          )}

        {/* Per-account headings don't fit the rail, so it shows none. */}
        {unified && !collapsed ? accountSections : null}
        {unified ? null : (
          <MailboxGroups
            activeLabelId={activeLabelId}
            activeFolderId={activeFolderId}
            hrefFor={hrefFor}
            labels={labels}
            folders={folders}
            countsById={countsById}
            labelsHeading={labelsHeading}
            labelSingular={labelSingular}
            labelEditMode={labelEditMode}
            supportsLabelVisibility={supportsLabelVisibility}
            collapsed={collapsed}
            dropAccountId={dropAccountId}
            editing={{
              labelColorOptions,
              onCreateLabel,
              onEditMailboxItem,
              onDeleteMailboxItem,
            }}
          />
        )}

        {connectors ? (
          <>
            <GroupHeading collapsed={collapsed}>Connectors</GroupHeading>
            {connectors}
          </>
        ) : null}

        {/* Like More, the rail has no toggle, so it lists no tools. */}
        {toolLinks?.length && !collapsed ? (
          <>
            <GroupHeading
              expanded={showTools}
              onToggle={() => setShowTools(!showTools)}
            >
              Tools
            </GroupHeading>
            {showTools && (
              <div
                role="group"
                aria-label="Tools"
                className="flex flex-col gap-px"
              >
                {toolLinks.map((link) => (
                  <NavRow
                    key={link.href}
                    href={link.href}
                    active={false}
                    icon={link.icon}
                    name={link.name}
                    detail={link.account}
                    count={null}
                  />
                ))}
              </div>
            )}
          </>
        ) : null}
      </nav>
      {appLinks?.length ? (
        // Pinned outside the scrolling mailboxes, so the way to the rest of
        // the app never scrolls out of view.
        <nav
          aria-label="App"
          className="mt-2 flex shrink-0 flex-col gap-px border-border border-t pt-2"
        >
          {appLinks.map((link) => (
            <NavRow
              key={link.href}
              href={link.href}
              active={false}
              icon={link.icon}
              name={link.name}
              detail={link.account}
              count={null}
              collapsed={collapsed}
            />
          ))}
        </nav>
      ) : null}
      {footer}
    </aside>
  );
}

type MailboxEditing = Pick<
  MailSidebarProps,
  | "labelColorOptions"
  | "onCreateLabel"
  | "onEditMailboxItem"
  | "onDeleteMailboxItem"
>;

type LabelRowProps = Pick<
  MailSidebarProps,
  | "activeLabelId"
  | "hrefFor"
  | "countsById"
  | "labelSingular"
  | "labelEditMode"
  | "supportsLabelVisibility"
> & {
  /** Omitted where rows only navigate, like another account's labels in All inboxes. */
  editing?: MailboxEditing;
  /** Rows open another account, which loads fresh like the account switcher does. */
  reloadDocument?: boolean;
  dropAccountId?: string;
};

/** An account's own folders and labels: the single-account sidebar's lower half. */
export function MailboxGroups({
  activeFolderId,
  labels,
  folders,
  labelsHeading,
  collapsed,
  ...rowProps
}: LabelRowProps &
  Pick<
    MailSidebarProps,
    "activeFolderId" | "labels" | "folders" | "labelsHeading"
  > & { collapsed: boolean }) {
  const {
    activeLabelId,
    hrefFor,
    countsById,
    labelSingular,
    labelEditMode,
    editing,
    reloadDocument,
  } = rowProps;
  const [isAddingLabel, setIsAddingLabel] = useState(false);
  const [newLabelName, setNewLabelName] = useState("");
  const [showLabels, setShowLabels] = useState(true);
  const [showHiddenLabels, setShowHiddenLabels] = useState(false);
  const sidebarFolders = getMailSidebarFolders(folders);
  const { visibleLabels, hiddenLabels } = splitLabelsByListVisibility({
    labels,
    countsById,
  });
  const labelTree = getLabelTree(
    visibleLabels,
    labelEditMode === "name-and-color",
  );
  const hasNestedLabels = labelTree.some((root) => root.children.length > 0);
  // Hidden labels stay flat: they are an escape hatch, not a place to browse.
  const hiddenLabelNodes = getLabelTree(hiddenLabels, false);
  const hasHiddenActiveLabel = hiddenLabels.some(
    (label) => label.id === activeLabelId,
  );
  // Without a create button an empty group would be a heading over nothing.
  const showLabelGroup = collapsed
    ? showLabels && labelTree.length > 0
    : Boolean(editing) || labels.length > 0;

  // Expand when the open view changes to a label so a collapsed list can
  // still reveal the selected row. A same-label collapse stays put.
  useEffect(() => {
    if (activeLabelId) setShowLabels(true);
  }, [activeLabelId]);

  // Opening a hidden label from elsewhere (search, a thread's chips) must not
  // leave the sidebar without a row for the view the user is looking at.
  useEffect(() => {
    if (hasHiddenActiveLabel) setShowHiddenLabels(true);
  }, [hasHiddenActiveLabel]);

  const submitNewLabel = (event: FormEvent) => {
    event.preventDefault();
    const name = newLabelName.trim();
    if (!name || !editing) return;
    editing.onCreateLabel(name);
    setNewLabelName("");
    setIsAddingLabel(false);
  };

  return (
    <>
      {sidebarFolders.length > 0 && (
        <>
          <GroupHeading collapsed={collapsed}>Folders</GroupHeading>
          <div
            role="group"
            aria-label="Folders"
            className="flex flex-col gap-px"
          >
            {sidebarFolders.map((folder) => (
              <EditableMailboxItem
                key={folder.id}
                editing={editing}
                item={{
                  kind: "folder",
                  id: folder.id,
                  name: folder.displayName,
                }}
                typeName="folder"
                editMode="name"
                showOptionsButton={!collapsed}
              >
                <NavRow
                  href={hrefFor({ kind: "folder", folderId: folder.id })}
                  reloadDocument={reloadDocument}
                  active={activeFolderId === folder.id}
                  icon={
                    <FolderIcon
                      className="size-3.5 shrink-0"
                      style={
                        collapsed
                          ? undefined
                          : { marginLeft: folder.depth * 12 }
                      }
                    />
                  }
                  name={folder.displayName}
                  count={displayCount(countsById.get(folder.id))}
                  collapsed={collapsed}
                  dropTarget={FOLDER_DROP_TARGET}
                />
              </EditableMailboxItem>
            ))}
          </div>
        </>
      )}

      {showLabelGroup ? (
        <>
          <GroupHeading
            collapsed={collapsed}
            expanded={showLabels}
            onToggle={() => setShowLabels((open) => !open)}
            action={
              editing ? (
                <button
                  type="button"
                  onClick={() => {
                    setShowLabels(true);
                    setIsAddingLabel((open) => !open);
                  }}
                  aria-expanded={isAddingLabel}
                  aria-label={`Create ${labelSingular}`}
                  className="rounded-md p-0.5 text-muted-foreground hover:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <PlusIcon className="size-3.5" />
                </button>
              ) : null
            }
          >
            {labelsHeading}
          </GroupHeading>
          {showLabels && (
            <div
              role="group"
              aria-label={labelsHeading}
              className="flex flex-col gap-px"
            >
              {labelTree.map((node) => (
                <LabelBranch
                  key={node.label.id}
                  node={node}
                  hasNestedLabels={hasNestedLabels}
                  collapsed={collapsed}
                  {...rowProps}
                />
              ))}
            </div>
          )}

          {showLabels && hiddenLabelNodes.length > 0 && !collapsed && (
            <>
              <button
                type="button"
                onClick={() => setShowHiddenLabels((open) => !open)}
                aria-expanded={showHiddenLabels}
                className="flex items-center gap-1 rounded-md px-2.5 py-1 text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {showHiddenLabels ? (
                  <ChevronDownIcon className="size-3" />
                ) : (
                  <ChevronRightIcon className="size-3" />
                )}
                More
              </button>
              {showHiddenLabels && (
                <div
                  role="group"
                  aria-label={`More ${labelsHeading.toLowerCase()}`}
                  className="flex flex-col gap-px"
                >
                  {hiddenLabelNodes.map((node) => (
                    <LabelBranch
                      key={node.label.id}
                      node={node}
                      hasNestedLabels={false}
                      collapsed={collapsed}
                      {...rowProps}
                    />
                  ))}
                </div>
              )}
            </>
          )}

          {showLabels && isAddingLabel && !collapsed ? (
            <form
              onSubmit={submitNewLabel}
              className="flex gap-1.5 px-2.5 py-2"
            >
              <Input
                value={newLabelName}
                onChange={(event) => setNewLabelName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") setIsAddingLabel(false);
                }}
                placeholder={`${labelSingular} name`}
                aria-label={`New ${labelSingular} name`}
                autoFocus
                className="h-7 min-w-0 flex-1 px-2 text-xs"
              />
              <Button type="submit" size="xs-2" disabled={!newLabelName.trim()}>
                Add
              </Button>
            </form>
          ) : null}
        </>
      ) : null}
    </>
  );
}

function EditableMailboxItem({
  editing,
  children,
  ...menuProps
}: Omit<
  ComponentProps<typeof MailboxItemContextMenu>,
  "onEdit" | "onDelete"
> & { editing: MailboxEditing | undefined }) {
  if (!editing) return children;

  return (
    <MailboxItemContextMenu
      {...menuProps}
      onEdit={editing.onEditMailboxItem}
      onDelete={editing.onDeleteMailboxItem}
    >
      {children}
    </MailboxItemContextMenu>
  );
}

function LabelBranch({
  node,
  hasNestedLabels,
  collapsed,
  ...props
}: LabelRowProps & {
  node: SidebarLabel;
  hasNestedLabels: boolean;
  collapsed: boolean;
}) {
  const { label, children } = node;
  const activeDescendantId = children.some((child) =>
    containsLabel(child, props.activeLabelId),
  )
    ? props.activeLabelId
    : null;
  // Branches start closed so a deep label tree doesn't flood the sidebar; only
  // the branch holding the open label reveals itself.
  const [expansion, setExpansion] = useState({
    activeDescendantId,
    expanded: activeDescendantId !== null,
  });
  // Reveal each newly selected descendant while retaining unrelated collapse choices.
  if (expansion.activeDescendantId !== activeDescendantId) {
    setExpansion({
      activeDescendantId,
      expanded: activeDescendantId !== null || expansion.expanded,
    });
  }
  // The rail has no room for a disclosure arrow, so it lists every label flat.
  const expanded = collapsed || expansion.expanded;

  return (
    <div>
      <EditableMailboxItem
        editing={props.editing}
        item={{ kind: "label", id: label.id, name: label.name }}
        typeName={props.labelSingular}
        editMode={props.labelEditMode}
        currentColor={label.color}
        colorOptions={props.editing?.labelColorOptions}
        showOptionsButton={!collapsed}
        visibility={
          props.supportsLabelVisibility
            ? {
                labelList: label.labelListVisibility,
                messageList: label.messageListVisibility,
              }
            : undefined
        }
      >
        <div className="relative">
          {children.length > 0 && !collapsed && (
            <button
              type="button"
              aria-label={`${expanded ? "Collapse" : "Expand"} ${label.name}`}
              aria-expanded={expanded}
              onClick={() =>
                setExpansion({ activeDescendantId, expanded: !expanded })
              }
              className="absolute top-1/2 left-0 z-10 flex size-6 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              {expanded ? (
                <ChevronDownIcon className="size-3" />
              ) : (
                <ChevronRightIcon className="size-3" />
              )}
            </button>
          )}
          <NavRow
            href={props.hrefFor({ kind: "label", labelId: label.id })}
            reloadDocument={props.reloadDocument}
            active={props.activeLabelId === label.id}
            icon={
              collapsed ? (
                <TagIcon
                  className="size-4 shrink-0"
                  style={{ color: label.color?.backgroundColor }}
                />
              ) : (
                <span
                  className="size-2.5 shrink-0 rounded-full bg-muted-foreground/40"
                  style={
                    label.color?.backgroundColor
                      ? { backgroundColor: label.color.backgroundColor }
                      : undefined
                  }
                />
              )
            }
            // Flattened rows lose their parent context, so the tooltip carries
            // the full path instead of the leaf name.
            name={collapsed ? label.name : node.name}
            count={displayCount(props.countsById.get(label.id))}
            nested={hasNestedLabels && !collapsed}
            collapsed={collapsed}
            dropTarget={
              props.dropAccountId
                ? {
                    kind: "label",
                    accountId: props.dropAccountId,
                    labelId: label.id,
                  }
                : undefined
            }
          />
        </div>
      </EditableMailboxItem>
      {expanded && children.length > 0 && (
        <div className={collapsed ? undefined : "ml-3"}>
          {children.map((child) => (
            <LabelBranch
              key={child.label.id}
              node={child}
              hasNestedLabels={hasNestedLabels}
              collapsed={collapsed}
              {...props}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupHeading({
  children,
  action,
  expanded,
  onToggle,
  dragHandlers,
  collapsed,
}: {
  children: ReactNode;
  action?: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
  /** Mail dragged over the heading, which may open the group. */
  dragHandlers?: Pick<
    ComponentProps<"div">,
    "onDragEnter" | "onDragOver" | "onDragLeave"
  >;
  collapsed?: boolean;
}) {
  // A heading can't fit in the rail, so groups are separated by a rule instead.
  if (collapsed) return <div className="mx-auto my-2 h-px w-6 bg-border" />;

  return (
    <div
      className="flex items-center gap-1 px-2.5 pt-4 pb-1.5"
      {...dragHandlers}
    >
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 cursor-pointer items-center font-medium text-muted-foreground text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="truncate">{children}</span>
        </button>
      ) : (
        <span className="flex-1 font-medium text-muted-foreground text-xs">
          {children}
        </span>
      )}
      {action}
      {onToggle ? (
        <button
          type="button"
          onClick={onToggle}
          tabIndex={-1}
          aria-hidden="true"
          className="cursor-pointer rounded-md p-0.5 text-muted-foreground hover:text-foreground"
        >
          {expanded ? (
            <ChevronDownIcon className="size-3 shrink-0" />
          ) : (
            <ChevronRightIcon className="size-3 shrink-0" />
          )}
        </button>
      ) : null}
    </div>
  );
}

function NavRow({
  href,
  active,
  icon,
  name,
  detail,
  count,
  emphasizeCount,
  nested,
  collapsed,
  reloadDocument,
  prefetch,
  onIntent,
  onIntentEnd,
  dropTarget,
}: {
  dropTarget?: SidebarDropTarget;
  href?: string;
  reloadDocument?: boolean;
  /** Overrides the default: mail views of the open mail screen skip it. */
  prefetch?: boolean;
  onIntent?: () => void;
  onIntentEnd?: () => void;
  active: boolean;
  icon: ReactNode;
  name: string;
  detail?: string;
  count: number | null;
  emphasizeCount?: boolean;
  nested?: boolean;
  collapsed?: boolean;
}) {
  const pendingNavigation = useContext(PendingNavigationContext);
  const engineStarting = useMailEngineStarting();
  // aria-current stays with the open page; only the highlight runs ahead.
  const highlighted = isSidebarRowActive({
    active,
    href,
    pending: pendingNavigation.pending,
    pathname: pendingNavigation.pathname,
  });
  const presentation = getMailSidebarRowPresentation({
    active: highlighted,
    icon,
    name,
    count,
    emphasizeCount,
    nested,
    collapsed,
  });
  const { dragging, dropProps: drop } = useDropTarget({
    target: dropTarget,
    active,
  });
  const className = cn(
    presentation.className,
    // Only while dragging, so hover and selection stay instant; under
    // reduced motion the color change alone carries it.
    dragging &&
      "motion-safe:transition-[background-color,box-shadow,opacity] motion-safe:duration-100",
    "data-[drop=target]:bg-primary/10 data-[drop=target]:text-foreground data-[drop=target]:ring-2 data-[drop=target]:ring-primary/60 data-[drop=target]:ring-inset",
    "data-[drop=blocked]:opacity-50",
  );
  // The account a page opens follows its name, quieter, where there's room.
  const content =
    detail && !collapsed ? (
      <>
        {icon}
        <span className="shrink-0">{name}</span>
        <span className="min-w-0 flex-1 truncate text-sidebar-muted-foreground text-xs">
          {detail}
        </span>
      </>
    ) : (
      presentation.content
    );

  const row = href ? (
    reloadDocument ? (
      <a
        href={href}
        aria-current={active ? "page" : undefined}
        className={className}
        {...drop}
      >
        {content}
      </a>
    ) : (
      <Link
        href={href}
        aria-current={active ? "page" : undefined}
        data-highlighted={highlighted || undefined}
        className={className}
        {...drop}
        // Views of the open mail screen change on the client, so fetching
        // them from the server ahead of time would be wasted. Other pages
        // wait until the mail engine has started, so they don't compete with
        // its first load.
        prefetch={
          prefetch ??
          (engineStarting || parseMailPath(href.split("?")[0])
            ? false
            : undefined)
        }
        onPointerEnter={onIntent}
        onFocus={onIntent}
        onPointerLeave={onIntentEnd}
        onBlur={onIntentEnd}
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (
            event.button !== 0 ||
            event.metaKey ||
            event.ctrlKey ||
            event.shiftKey ||
            event.altKey
          )
            return;
          if (showMailView(href)) event.preventDefault();
          else pendingNavigation.start(href);
        }}
      >
        {content}
      </Link>
    )
  ) : (
    <div
      aria-current={active ? "page" : undefined}
      className={className}
      {...drop}
    >
      {content}
    </div>
  );

  if (!collapsed) return row;

  return (
    <RailTooltip label={count === null ? name : `${name} (${count})`}>
      {row}
    </RailTooltip>
  );
}

const INBOX_DROP_TARGET: SidebarDropTarget = { kind: "inbox" };
const FOLDER_DROP_TARGET: SidebarDropTarget = { kind: "folder" };
const MORE_REVEAL_DELAY_MS = 600;

/**
 * Lets mail dragged from the list drop on a row. A row that can take the drop
 * highlights while the pointer is over it; one that can't (the open view, or
 * a label the mail's account lacks) dims and the browser shows a no-drop
 * cursor.
 */
function useDropTarget({
  target,
  active,
}: {
  target: SidebarDropTarget | undefined;
  active: boolean;
}) {
  const drag = useMailDrag();
  const setDrag = useSetMailDrag();
  // Keyed to the drag, so a drag that ended elsewhere leaves no highlight.
  const [hoveredBy, setHoveredBy] = useState<MailDrag | null>(null);
  const presence = useDragPresence(drag, (present) =>
    setHoveredBy(present ? drag : null),
  );
  if (!drag || !target) return { dragging: drag !== null, dropProps: {} };
  const action = resolveSidebarDrop({
    target,
    conversations: drag.conversations,
    isCurrentView: active,
  });
  const dropEffect =
    action?.kind === "label" || action?.kind === "star" ? "copy" : "move";
  // Files, text and links dragged in from elsewhere are none of the row's
  // business, whatever drag this tab remembers.
  const acceptDrag = (event: DragEvent) => {
    if (!isMailDragEvent(event.dataTransfer)) return false;
    if (action) {
      event.preventDefault();
      event.dataTransfer.dropEffect = dropEffect;
    } else event.dataTransfer.dropEffect = "none";
    return true;
  };

  return {
    dragging: true,
    dropProps: {
      "data-drop":
        hoveredBy === drag ? (action ? "target" : "blocked") : undefined,
      onDragEnter: (event: DragEvent) => {
        if (acceptDrag(event)) presence.enter();
      },
      onDragOver: (event: DragEvent) => {
        if (acceptDrag(event)) presence.over();
      },
      onDragLeave: (event: DragEvent) => {
        if (isMailDragEvent(event.dataTransfer)) presence.leave();
      },
      onDrop: (event: DragEvent) => {
        if (!isMailDragEvent(event.dataTransfer)) return;
        event.preventDefault();
        presence.reset();
        setHoveredBy(null);
        // Another tab's mail drag carries the same type but not this nonce.
        if (event.dataTransfer.getData(MAIL_DRAG_TYPE) !== drag.nonce) return;
        setDrag(null);
        if (action) drag.onDrop(action);
      },
    },
  };
}

const PendingNavigationContext = createContext<{
  pending: PendingNavigation | null;
  pathname: string;
  start: (href: string) => void;
}>({ pending: null, pathname: "", start: () => {} });

/** Lets a row show as current as soon as it's clicked; see `isSidebarRowActive`. */
function PendingNavigationProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname() ?? "";
  const { pending, start } = usePendingNavigation(pathname);
  const value = useMemo(
    () => ({ pending, pathname, start }),
    [pending, pathname, start],
  );
  return (
    <PendingNavigationContext.Provider value={value}>
      {children}
    </PendingNavigationContext.Provider>
  );
}

/** Names a rail control that has room for its icon only. `null` when expanded. */
export function RailTooltip({
  label,
  children,
}: {
  label: string | null;
  children: ReactNode;
}) {
  if (!label) return children;

  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

export function getMailCategories({
  isGoogle,
  isOutlook,
}: {
  isGoogle: boolean;
  isOutlook: boolean;
}): MailCategory[] {
  if (isGoogle) return MAIL_CATEGORIES;
  if (isOutlook) return OUTLOOK_INBOX_CATEGORIES;
  return [];
}

/**
 * Drafts are never unread, so the only number worth showing there is the total.
 * A zero is noise, so it renders as nothing at all.
 */
function displayCount(count: MailboxLabelCount | undefined): number | null {
  if (!count) return null;
  const value = count.id === "DRAFT" ? count.total : count.unread;
  return value > 0 ? value : null;
}

function containsLabel(node: SidebarLabel, labelId: string | null): boolean {
  return (
    node.label.id === labelId ||
    node.children.some((child) => containsLabel(child, labelId))
  );
}

/**
 * A sidebar group's open state, kept in this browser so the group stays the
 * way the user left it. When storage is unavailable (a private window, blocked
 * site data) the choice lasts for this page load instead.
 */
function useStoredDisclosure(key: string) {
  const open = useSyncExternalStore(
    subscribeToStoredDisclosures,
    () => readStoredDisclosure(key),
    () => false,
  );
  const setOpen = useCallback(
    (next: boolean) => {
      try {
        window.localStorage.setItem(key, next ? "1" : "0");
      } catch {
        storedDisclosureFallback.set(key, next);
      }
      for (const listener of storedDisclosureListeners) listener();
    },
    [key],
  );
  return [open, setOpen] as const;
}

const storedDisclosureListeners = new Set<() => void>();
const storedDisclosureFallback = new Map<string, boolean>();

function subscribeToStoredDisclosures(listener: () => void) {
  storedDisclosureListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    storedDisclosureListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}

function readStoredDisclosure(key: string) {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return storedDisclosureFallback.get(key) ?? false;
  }
}
