import Link from "next/link";
import { Logo } from "@/components/Logo";

/**
 * For pages on the way into the app, like sign-in errors. Just the logo: the
 * marketing site's navigation and footer don't belong to the product.
 */
export function SignInLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-background px-4 text-foreground">
      <header className="mx-auto w-full max-w-6xl py-6">
        <Link href="/login" aria-label="Sign in">
          <Logo className="h-6" />
        </Link>
      </header>
      <main className="mx-auto w-full max-w-6xl flex-1">{children}</main>
    </div>
  );
}
