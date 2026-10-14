import Link from "next/link";
import type { AllInboxesAccount } from "@/app/(app)/[emailAccountId]/mail/all-inboxes";

/** Names the inboxes All inboxes is missing, and where to fix them. */
export function AllInboxesFailedNotice({
  accounts,
  failedAccountIds,
}: {
  accounts: AllInboxesAccount[];
  failedAccountIds: string[];
}) {
  if (!failedAccountIds.length) return null;
  const emails = accounts
    .filter((account) => failedAccountIds.includes(account.id))
    .map((account) => account.email);
  const missing = emails.length ? emails.join(", ") : "Some inboxes";

  return (
    <p
      role="status"
      className="border-border border-b bg-amber-50 px-3 py-2 text-amber-900 text-xs dark:bg-amber-950/30 dark:text-amber-200"
    >
      {missing} couldn&apos;t be loaded, so{" "}
      {emails.length === 1 ? "its" : "their"} mail is missing here. Try again in
      a moment, or{" "}
      <Link
        href="/accounts"
        className="font-medium underline underline-offset-2"
      >
        check {emails.length === 1 ? "its connection" : "their connections"}
      </Link>
      .
    </p>
  );
}
