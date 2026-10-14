import { MailScreenLayout } from "@/app/(app)/[emailAccountId]/mail/MailScreenLayout";

// Today is a view of the mail app, so it shares mail's theme, sidebar width
// and shortcuts.
export default function TodayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MailScreenLayout>{children}</MailScreenLayout>;
}
