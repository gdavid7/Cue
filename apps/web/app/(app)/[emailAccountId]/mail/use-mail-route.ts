import { useCallback, useMemo } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import type { MailNavTarget } from "@/app/(app)/[emailAccountId]/mail/MailSidebar";
import { useAccount } from "@/providers/EmailAccountProvider";
import type { OutlookFolder } from "@/utils/outlook/folders";
import {
  buildMailPath,
  getLabelSlugs,
  type MailUrl,
  type MailUrlView,
  parseMailPath,
  withPageParams,
} from "@/utils/mail-url";

export type MailSlugs = {
  labels: ReadonlyMap<string, string>;
  folders: ReadonlyMap<string, string>;
};

/**
 * The mail screen's view, read from `/mail/u/{n}/…`, and a way to change it.
 * Changes go through the History API, as nuqs's shallow updates did, so
 * opening a thread or switching tabs never waits on the server.
 */
export function useMailRoute() {
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { emailAccountId, accountIds } = useAccount();
  const fallbackIndex = Math.max(accountIds.indexOf(emailAccountId), 0);

  const location: MailUrl = useMemo(
    () =>
      parseMailPath(pathname ?? "", searchParams) ?? {
        accountIndex: fallbackIndex,
        view: { kind: "inbox" },
        threadId: null,
        threadAccountIndex: null,
      },
    [pathname, searchParams, fallbackIndex],
  );

  /**
   * Updates read the address at call time rather than this render's copy, so
   * several in one handler compose instead of the last one winning.
   */
  const updateLocation = useCallback(
    (update: (current: MailUrl) => MailUrl) => {
      const current = parseMailPath(
        window.location.pathname,
        window.location.search,
      );
      // Off the mail screen there is no view to change.
      if (!current) return;
      window.history.replaceState(
        null,
        "",
        withPageParams(buildMailPath(update(current)), window.location.search),
      );
    },
    [],
  );

  return { location, updateLocation };
}

/** Slugs for an account's labels and folders, as its sidebar links use. */
export function useMailSlugs(
  labels: readonly { id: string; name: string }[],
  folders: readonly OutlookFolder[],
): MailSlugs {
  return useMemo(
    () => ({
      labels: getLabelSlugs(labels),
      folders: getLabelSlugs(flattenFolders(folders)),
    }),
    [labels, folders],
  );
}

export function getMailNavView(
  target: MailNavTarget,
  slugs: MailSlugs,
): MailUrlView {
  switch (target.kind) {
    case "label":
      return {
        kind: "label",
        slug: slugs.labels.get(target.labelId) ?? target.labelId,
      };
    case "folder":
      return {
        kind: "folder",
        slug: slugs.folders.get(target.folderId) ?? target.folderId,
      };
    case "type":
      return target.type === "inbox"
        ? { kind: "inbox" }
        : { kind: "type", type: target.type };
  }
}

/** Nested folders read as their path, so `Clients/Acme` slugs as `clients-acme`. */
function flattenFolders(
  folders: readonly OutlookFolder[],
  parentName = "",
): { id: string; name: string }[] {
  return folders.flatMap((folder) => {
    const name = parentName
      ? `${parentName} ${folder.displayName}`
      : folder.displayName;
    return [
      { id: folder.id, name },
      ...flattenFolders(folder.childFolders ?? [], name),
    ];
  });
}
