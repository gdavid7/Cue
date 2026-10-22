"use client";

import type { ReactNode } from "react";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useLocalStorage } from "usehooks-ts";
import {
  getAccountColorClassName,
  getAllInboxesAccounts,
  isAccountSectionOpen,
} from "@/app/(app)/[emailAccountId]/mail/all-inboxes";
import {
  MailboxGroups,
  type MailNavTarget,
} from "@/app/(app)/[emailAccountId]/mail/MailSidebar";
import { getMailSidebarFolders } from "@/app/(app)/[emailAccountId]/mail/outlook-folder-list";
import {
  getMailNavView,
  useMailSlugs,
} from "@/app/(app)/[emailAccountId]/mail/use-mail-route";
import type { GetEmailAccountsResponse } from "@/app/api/user/email-accounts/route";
import { LoadingContent } from "@/components/LoadingContent";
import { useFolders } from "@/hooks/useFolders";
import { useLabelCounts } from "@/hooks/useLabelCounts";
import { useLabels } from "@/hooks/useLabels";
import { useMailHref } from "@/hooks/useMailHref";
import { cn } from "@/utils";
import {
  isGoogleProvider,
  isMicrosoftProvider,
} from "@/utils/email/provider-types";
import { getEmailTerminology } from "@/utils/terminology";

type EmailAccount = GetEmailAccountsResponse["emailAccounts"][number];

/**
 * All inboxes keeps each account's own labels or folders apart: Gmail labels
 * and Outlook folders and categories don't merge into one honest list, so
 * each row opens that account's own view.
 */
export function AllInboxesSidebarSections({
  emailAccounts,
}: {
  emailAccounts: EmailAccount[];
}) {
  const accounts = getAllInboxesAccounts(emailAccounts);
  const providerById = new Map(
    emailAccounts.map((emailAccount) => [
      emailAccount.id,
      emailAccount.account.provider,
    ]),
  );

  return (
    <div className="mt-3 flex flex-col gap-1">
      {accounts.map((account, index) => (
        <AccountSection
          key={account.id}
          accountId={account.id}
          email={account.email}
          provider={providerById.get(account.id) ?? ""}
          colorClassName={getAccountColorClassName(index)}
          accountCount={accounts.length}
        />
      ))}
    </div>
  );
}

function AccountSection({
  accountId,
  email,
  provider,
  colorClassName,
  accountCount,
}: {
  accountId: string;
  email: string;
  provider: string;
  colorClassName: string;
  accountCount: number;
}) {
  const [storedOpen, setStoredOpen] = useLocalStorage<boolean | null>(
    `cue-all-inboxes-sidebar-open:${accountId}`,
    null,
  );
  const open = isAccountSectionOpen({ storedOpen, accountCount });

  return (
    <section aria-label={email}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setStoredOpen(!open)}
        className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {/* Same color and initial as this account's rows in the list. */}
        <span
          aria-hidden
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded-full font-medium text-[10px] text-white",
            colorClassName,
          )}
        >
          {email.trim().at(0)?.toUpperCase() || "@"}
        </span>
        <span className="min-w-0 flex-1 truncate font-medium">{email}</span>
        {open ? (
          <ChevronDownIcon className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3 shrink-0 text-muted-foreground" />
        )}
      </button>
      {/* Mounted only when open, so closed sections don't fetch anything. */}
      {open ? (
        <AccountMailboxes accountId={accountId} provider={provider} />
      ) : null}
    </section>
  );
}

function AccountMailboxes({
  accountId,
  provider,
}: {
  accountId: string;
  provider: string;
}) {
  const isOutlook = isMicrosoftProvider(provider);
  const terminology = getEmailTerminology(provider);
  const labelsState = useLabels(accountId);
  const foldersState = useFolders(provider, accountId);
  const { countsById } = useLabelCounts({
    emailAccountId: accountId,
    labels: labelsState.userLabels,
    folders: foldersState.folders,
  });
  const mailHref = useMailHref();
  const mailSlugs = useMailSlugs(labelsState.userLabels, foldersState.folders);
  const hrefFor = (target: MailNavTarget) =>
    mailHref({ accountId, view: getMailNavView(target, mailSlugs) });
  const isEmpty =
    labelsState.userLabels.length === 0 &&
    getMailSidebarFolders(foldersState.folders).length === 0;

  return (
    <div className="ml-3 border-border border-l pl-1">
      <LoadingContent
        loading={labelsState.isLoading || foldersState.isLoading}
        error={labelsState.error ?? foldersState.error}
        loadingComponent={<SectionNote>Loading…</SectionNote>}
        errorComponent={
          <SectionNote>
            Couldn't load {terminology.label.plural} for this account.
          </SectionNote>
        }
      >
        {isEmpty ? (
          <SectionNote>No {terminology.label.plural} yet.</SectionNote>
        ) : (
          <MailboxGroups
            activeLabelId={null}
            activeFolderId={null}
            hrefFor={hrefFor}
            labels={labelsState.userLabels}
            folders={foldersState.folders}
            countsById={countsById}
            labelsHeading={terminology.label.pluralCapitalized}
            labelSingular={terminology.label.singular}
            labelEditMode={isOutlook ? "color" : "name-and-color"}
            supportsLabelVisibility={isGoogleProvider(provider)}
            collapsed={false}
            reloadDocument
            dropAccount={{ id: accountId, provider }}
          />
        )}
      </LoadingContent>
    </div>
  );
}

function SectionNote({ children }: { children: ReactNode }) {
  return (
    <p className="px-2.5 py-1.5 text-muted-foreground text-xs">{children}</p>
  );
}
