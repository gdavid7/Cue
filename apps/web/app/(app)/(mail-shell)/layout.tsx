import { MailFrame } from "@/app/(app)/[emailAccountId]/mail/MailFrame";
import { MailScreenLayout } from "@/app/(app)/[emailAccountId]/mail/MailScreenLayout";

// Mail (`/mail/u/{n}/…`) and Today (`/{emailAccountId}/home`) are two views of
// one mail app. Sharing this layout keeps the sidebar, its counts, the theme
// and the shortcuts mounted while moving between them, so only the content
// beside the sidebar is replaced and nothing it already loaded is fetched again.
export default function MailShellLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <MailScreenLayout>
      <MailFrame>{children}</MailFrame>
    </MailScreenLayout>
  );
}
