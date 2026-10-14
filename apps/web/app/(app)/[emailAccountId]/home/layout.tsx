import MailLayout from "@/app/(app)/[emailAccountId]/mail/layout";

// Today is a view of the mail app, so it shares mail's theme, sidebar width
// and shortcuts.
export default function TodayLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <MailLayout>{children}</MailLayout>;
}
