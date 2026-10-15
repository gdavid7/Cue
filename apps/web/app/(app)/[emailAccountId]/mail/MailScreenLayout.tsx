import { cookies } from "next/headers";
import { MailThemeScope } from "@/app/(app)/[emailAccountId]/mail/MailThemeScope";
import {
  clampMailSidebarWidth,
  MAIL_SIDEBAR_WIDTH_COOKIE,
} from "@/app/(app)/[emailAccountId]/mail/sidebar-width";
import { ShortcutsProvider } from "@/lib/shortcuts/ShortcutsProvider";
import { MAIL_SHORTCUT_SCOPES } from "@/lib/shortcuts/registry";

/** Mail and Today share the theme, sidebar width and shortcuts. */
export async function MailScreenLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const cookieStore = await cookies();
  const sidebarWidth = clampMailSidebarWidth(
    Number.parseInt(
      cookieStore.get(MAIL_SIDEBAR_WIDTH_COOKIE)?.value ?? "",
      10,
    ),
  );

  // CommandK's provider only wraps its own palette, so the mail screen needs its
  // own for react-hotkeys-hook to have any active scope to bind against.
  return (
    <ShortcutsProvider scopes={MAIL_SHORTCUT_SCOPES}>
      <MailThemeScope />
      {/* On the root so toasts, rendered outside this layout, can clear it. */}
      <style>{`:root{--mail-sidebar-width:${sidebarWidth}px}`}</style>
      {/* The root's theme comes from an effect, after the server's HTML has
          painted; this scope gives that first paint the same palette. */}
      <div className="contents" data-theme="mail">
        {children}
      </div>
    </ShortcutsProvider>
  );
}
