import Link from "next/link";
import { Logo } from "@/components/Logo";
import { BRAND_NAME } from "@/utils/branding";

/**
 * Shell for /privacy and /terms. Their text is a placeholder until the
 * founder replaces it, and the banner says so on the page itself.
 */
export function LegalPage({
  title,
  sections,
}: {
  title: string;
  sections: { heading: string; body: React.ReactNode }[];
}) {
  return (
    <main className="min-h-screen bg-background px-4 py-10 text-foreground sm:px-6 sm:py-16">
      <article className="mx-auto max-w-2xl">
        <Link href="/login" aria-label="Back to sign in">
          <Logo className="h-6 text-foreground" />
        </Link>
        <h1 className="mt-10 font-title text-3xl tracking-tight sm:text-4xl">
          {title}
        </h1>
        <p
          role="note"
          className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4 text-amber-950 text-sm dark:border-amber-700 dark:bg-amber-950/40 dark:text-amber-100"
        >
          <strong className="font-semibold">Placeholder text.</strong> This page
          is a draft that will be replaced before {BRAND_NAME} opens more
          widely. It is not yet a binding agreement.
        </p>
        <div className="mt-8 space-y-8">
          {sections.map((section) => (
            <section key={section.heading}>
              <h2 className="font-semibold text-lg">{section.heading}</h2>
              <div className="mt-2 space-y-3 text-muted-foreground leading-relaxed">
                {section.body}
              </div>
            </section>
          ))}
        </div>
        <nav
          aria-label="Legal"
          className="mt-12 flex gap-4 border-t pt-6 text-muted-foreground text-sm"
        >
          <Link href="/login" className="hover:text-foreground">
            Back to sign in
          </Link>
          <Link href="/terms" className="hover:text-foreground">
            Terms
          </Link>
          <Link href="/privacy" className="hover:text-foreground">
            Privacy
          </Link>
        </nav>
      </article>
    </main>
  );
}
