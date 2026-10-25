"use client";

import { ConnectorsList } from "@/components/connectors/ConnectorsList";
import { LogOutIcon, SettingsIcon } from "lucide-react";
import {
  type CSSProperties,
  memo,
  type ReactNode,
  useCallback,
  useMemo,
} from "react";
import { toast } from "sonner";
import { ChangesWaiting } from "@/app/(app)/[emailAccountId]/mail/ChangesWaiting";
import { AllInboxesSidebarSections } from "@/app/(app)/[emailAccountId]/mail/AllInboxesSidebarSections";
import { MailAccountSwitcher } from "@/app/(app)/[emailAccountId]/mail/MailAccountSwitcher";
import {
  getMailCategories,
  type MailCategory,
  MailSidebar,
  type MailNavTarget,
} from "@/app/(app)/[emailAccountId]/mail/MailSidebar";
import type {
  MailboxItem,
  MailboxItemEdit,
} from "@/app/(app)/[emailAccountId]/mail/MailboxItemContextMenu";
import { getSystemRuleLabelIds } from "@/app/(app)/[emailAccountId]/mail/label-visibility";
import { MailSidebarResizeHandle } from "@/app/(app)/[emailAccountId]/mail/MailSidebarResizeHandle";
import {
  MAIL_SIDEBAR_DEFAULT_WIDTH,
  MAIL_SIDEBAR_RAIL_WIDTH,
} from "@/app/(app)/[emailAccountId]/mail/sidebar-width";
import { getAllInboxesAccounts } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import { useMailAppLinks } from "@/app/(app)/[emailAccountId]/mail/use-mail-app-links";
import {
  getMailNavView,
  useMailSlugs,
} from "@/app/(app)/[emailAccountId]/mail/use-mail-route";
import { useMailHref } from "@/hooks/useMailHref";
import { useWarmHome } from "@/hooks/useHome";
import { useTodayHref } from "@/hooks/useTodayHref";
import { useIntent } from "@/hooks/useIntent";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { Sidebar, useSidebar } from "@/components/ui/sidebar";
import { useSettingsDialog } from "@/hooks/useSettingsDialog";
import { useAccounts } from "@/hooks/useAccounts";
import { useFolders } from "@/hooks/useFolders";
import {
  useAllInboxesLabelCounts,
  useLabelCounts,
} from "@/hooks/useLabelCounts";
import { useLabels } from "@/hooks/useLabels";
import { useRules } from "@/hooks/useRules";
import { useAccount } from "@/providers/EmailAccountProvider";
import { useComposeModal } from "@/providers/ComposeModalProvider";
import type { EmailLabel } from "@/providers/email-label-types";
import type { OutlookFolder } from "@/utils/outlook/folders";
import {
  createLabelAction,
  deleteMailboxItemAction,
  updateMailboxItemAction,
} from "@/utils/actions/mail";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { getActionErrorMessage } from "@/utils/error";
import { GMAIL_LABEL_COLORS } from "@/utils/gmail/label-colors";
import { OUTLOOK_CATEGORY_COLORS } from "@/utils/outlook/category-colors";
import { getEmailTerminology } from "@/utils/terminology";
import { logOut } from "@/utils/user";

const OUTLOOK_LABEL_COLOR_OPTIONS = OUTLOOK_CATEGORY_COLORS.map((option) => ({
  name: option.name,
  backgroundColor: option.value,
  textColor: "#000000",
}));
const NO_LABELS: EmailLabel[] = [];
const NO_FOLDERS: OutlookFolder[] = [];
const NO_CATEGORIES: MailCategory[] = [];

/**
 * The mail screen's left column. It owns the label counts and mailbox editing
 * so their updates stay here, and is memoized so thread navigation and list
 * snapshots don't re-render it.
 */
export const MailShellSidebar = memo(function MailShellSidebar({
  activeType,
  activeLabelId,
  activeFolderId,
  isAllAccounts,
  isDesktopApp,
  onSelectAccount,
  onSelectAllAccounts,
  onMailboxItemDeleted,
  mobileOpen = false,
  onMobileOpenChange,
}: {
  activeType: string | null;
  activeLabelId: string | null;
  activeFolderId: string | null;
  isAllAccounts: boolean;
  isDesktopApp: boolean;
  onSelectAccount: (accountId: string) => void;
  onSelectAllAccounts: () => void;
  /** Leaves a view or split that the deleted label or folder defined. */
  onMailboxItemDeleted: (item: MailboxItem) => Promise<unknown>;
  /** Below `lg` the sidebar opens as a sheet from the phone's tab bar. */
  mobileOpen?: boolean;
  onMobileOpenChange?: (open: boolean) => void;
}) {
  const { emailAccountId, provider } = useAccount();
  // Reaching for Today starts its load, so it opens on data already coming.
  // A pointer that only passes over Today on its way elsewhere loads nothing.
  const todayIntent = useIntent();
  useWarmHome(emailAccountId, todayIntent.intended);
  const isGoogle = isGoogleProvider(provider);
  const isOutlook = isMicrosoftProvider(provider);
  const terminology = getEmailTerminology(provider);
  const { userLabels: allLabels, mutate: mutateLabels } = useLabels();
  const { data: rules, error: rulesError } = useRules();
  // Held back until the rules arrive, so Cue's own labels never flash in.
  const sidebarLabels = useMemo(() => {
    if (rulesError) return allLabels;
    if (!rules) return NO_LABELS;
    const systemLabelIds = getSystemRuleLabelIds(rules);
    return allLabels.filter((label) => !systemLabelIds.has(label.id));
  }, [allLabels, rules, rulesError]);
  const { folders, mutate: mutateFolders } = useFolders(provider);
  const { countsById, mutate: mutateCounts } = useLabelCounts({
    emailAccountId,
    labels: allLabels,
    folders,
  });
  const { onOpen: openCompose } = useComposeModal();
  const { data: accountsData } = useAccounts();
  const allInboxesAccounts = useMemo(
    () => getAllInboxesAccounts(accountsData?.emailAccounts ?? []),
    [accountsData?.emailAccounts],
  );
  const hasAllInboxes = allInboxesAccounts.length > 1;
  const allInboxesCountsById = useAllInboxesLabelCounts(
    isAllAccounts ? allInboxesAccounts : undefined,
  );
  const { appLinks, toolLinks } = useMailAppLinks();
  const { state: openSidebars } = useSidebar();
  const isMailSidebarOpen = openSidebars.includes("left-sidebar");
  const todayHref = useTodayHref();

  // Dragging writes straight to the CSS variable: re-rendering on every
  // pointer move would make the sidebar edge lag behind the cursor. It lives
  // on the root so toasts can clear the sidebar too.
  const setSidebarWidth = useCallback((width: number) => {
    document.documentElement.style.setProperty(
      "--mail-sidebar-width",
      `${width}px`,
    );
  }, []);

  const mailHref = useMailHref();
  const mailSlugs = useMailSlugs(allLabels, folders);
  // In All inboxes, its own views stay in All inboxes.
  const hrefFor = useCallback(
    (target: MailNavTarget) =>
      mailHref({
        ...(isAllAccounts ? { allInboxes: true } : {}),
        view: getMailNavView(target, mailSlugs),
      }),
    [isAllAccounts, mailHref, mailSlugs],
  );

  const onCreateLabel = useCallback(
    async (name: string) => {
      const result = await createLabelAction(emailAccountId, { name });
      if (result?.serverError || result?.validationErrors) {
        toast.error(getActionErrorMessage(result));
        return;
      }
      // Without this the label the user just typed doesn't appear until an
      // unrelated revalidation happens to run.
      await mutateLabels();
      toast.success(
        `${terminology.label.singularCapitalized} "${name}" created`,
      );
    },
    [emailAccountId, mutateLabels, terminology.label.singularCapitalized],
  );

  const onEditMailboxItem = useCallback(
    async (edit: MailboxItemEdit) => {
      const result = await updateMailboxItemAction(emailAccountId, edit);

      if (result?.serverError || result?.validationErrors) {
        toast.error(getActionErrorMessage(result));
        return false;
      }

      await Promise.all([
        edit.kind === "folder" ? mutateFolders() : mutateLabels(),
        mutateCounts(),
      ]);
      toast.success(
        `${edit.kind === "folder" ? "Folder" : terminology.label.singularCapitalized} updated`,
      );
      return true;
    },
    [
      emailAccountId,
      mutateCounts,
      mutateFolders,
      mutateLabels,
      terminology.label.singularCapitalized,
    ],
  );

  const onDeleteMailboxItem = useCallback(
    async (item: MailboxItem) => {
      const result = await deleteMailboxItemAction(emailAccountId, {
        kind: item.kind,
        id: item.id,
      });
      if (result?.serverError || result?.validationErrors) {
        toast.error(getActionErrorMessage(result));
        return false;
      }

      await Promise.all([
        onMailboxItemDeleted(item),
        item.kind === "folder" ? mutateFolders() : mutateLabels(),
        mutateCounts(),
      ]);
      toast.success(
        `${item.kind === "folder" ? "Folder" : terminology.label.singularCapitalized} deleted`,
      );
      return true;
    },
    [
      emailAccountId,
      mutateCounts,
      mutateFolders,
      mutateLabels,
      onMailboxItemDeleted,
      terminology.label.singularCapitalized,
    ],
  );

  const renderSidebar = ({
    collapsed,
    className,
    footer,
    showSidebarToggle,
  }: {
    collapsed: boolean;
    className: string;
    footer: ReactNode;
    showSidebarToggle: boolean;
  }) => (
    <MailSidebar
      className={className}
      collapsed={collapsed}
      showSidebarToggle={showSidebarToggle}
      activeType={activeType}
      activeLabelId={activeLabelId}
      activeFolderId={activeFolderId}
      hrefFor={hrefFor}
      labels={isAllAccounts ? NO_LABELS : sidebarLabels}
      folders={isAllAccounts || !isOutlook ? NO_FOLDERS : folders}
      countsById={isAllAccounts ? allInboxesCountsById : countsById}
      categories={
        isAllAccounts
          ? NO_CATEGORIES
          : getMailCategories({ isGoogle, isOutlook })
      }
      categoryHeading={isOutlook ? "Inbox" : "Categories"}
      collapsibleCategories={!isOutlook}
      labelsHeading={terminology.label.pluralCapitalized}
      labelSingular={terminology.label.singular}
      onCompose={openCompose}
      onCreateLabel={onCreateLabel}
      onEditMailboxItem={onEditMailboxItem}
      onDeleteMailboxItem={onDeleteMailboxItem}
      labelEditMode={isOutlook ? "color" : "name-and-color"}
      supportsLabelVisibility={isGoogle}
      supportsImportant={isGoogle}
      labelColorOptions={
        isOutlook ? OUTLOOK_LABEL_COLOR_OPTIONS : GMAIL_LABEL_COLORS
      }
      unified={isAllAccounts}
      accountSections={
        isAllAccounts ? (
          <AllInboxesSidebarSections
            emailAccounts={accountsData?.emailAccounts ?? []}
          />
        ) : undefined
      }
      // Dropped mail is labelled as the label picker does, for the
      // providers it offers labels for.
      dropAccountId={isGoogle || isOutlook ? emailAccountId : undefined}
      todayHref={todayHref}
      onTodayIntent={todayIntent.begin}
      onTodayIntentEnd={todayIntent.end}
      appLinks={appLinks}
      toolLinks={toolLinks}
      allInboxesHref={
        hasAllInboxes ? mailHref({ allInboxes: true }) : undefined
      }
      connectors={
        isAllAccounts ? undefined : (
          <ConnectorsList
            collapsed={collapsed}
            emailAccountId={emailAccountId}
          />
        )
      }
      footer={footer}
    />
  );

  return (
    <>
      <div
        className="hidden lg:contents"
        data-mail-sidebar={isMailSidebarOpen ? "open" : "rail"}
        style={
          {
            "--sidebar-width": `var(--mail-sidebar-width, ${MAIL_SIDEBAR_DEFAULT_WIDTH}px)`,
            "--sidebar-width-icon": `${MAIL_SIDEBAR_RAIL_WIDTH}px`,
          } as CSSProperties
        }
      >
        <Sidebar name="left-sidebar" collapsible="icon">
          {renderSidebar({
            className: "h-full w-full border-r-0",
            collapsed: !isMailSidebarOpen,
            showSidebarToggle: true,
            footer: (
              <>
                <ChangesWaiting collapsed={!isMailSidebarOpen} />
                <MailAccountSwitcher
                  isDesktopApp={isDesktopApp}
                  isAllAccounts={isAllAccounts}
                  onSelectAccount={onSelectAccount}
                  onSelectAll={onSelectAllAccounts}
                  variant="sidebar"
                  collapsed={!isMailSidebarOpen}
                />
              </>
            ),
          })}
          {isMailSidebarOpen ? (
            <MailSidebarResizeHandle onResize={setSidebarWidth} />
          ) : null}
        </Sidebar>
      </div>
      {onMobileOpenChange ? (
        <Sheet open={mobileOpen} onOpenChange={onMobileOpenChange}>
          <SheetContent
            side="left"
            aria-describedby={undefined}
            className="flex w-[min(20rem,85vw)] flex-col p-0 lg:hidden"
            // Every row is a link, so following one is leaving the sheet.
            onClickCapture={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("a[href]")
              )
                onMobileOpenChange(false);
            }}
          >
            <SheetTitle className="sr-only">Mailboxes</SheetTitle>
            {renderSidebar({
              className:
                "min-h-0 w-full flex-1 border-r-0 pt-12 pb-[max(0.625rem,env(safe-area-inset-bottom))]",
              collapsed: false,
              showSidebarToggle: false,
              footer: (
                <MobileSheetFooter onClose={() => onMobileOpenChange(false)} />
              ),
            })}
          </SheetContent>
        </Sheet>
      ) : null}
    </>
  );
});

/** The phone has no sidebar footer, so the sheet carries Settings and Sign out. */
function MobileSheetFooter({ onClose }: { onClose: () => void }) {
  const { openSettings } = useSettingsDialog();
  const rowClassName =
    "flex min-h-11 items-center gap-2.5 rounded-lg px-2.5 text-left text-sm hover:bg-muted active:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

  return (
    <div className="mt-2 flex shrink-0 flex-col gap-px border-border border-t pt-2">
      <ChangesWaiting />
      <button
        type="button"
        className={rowClassName}
        onClick={() => {
          onClose();
          openSettings();
        }}
      >
        <SettingsIcon className="size-4 shrink-0 text-muted-foreground" />
        Settings
      </button>
      <button type="button" className={rowClassName} onClick={() => logOut()}>
        <LogOutIcon className="size-4 shrink-0 text-muted-foreground" />
        Sign out
      </button>
    </div>
  );
}
