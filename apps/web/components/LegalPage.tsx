import Link from "next/link";
import { Logo } from "@/components/Logo";

/** Shell for /privacy and /terms. */
export function LegalPage({
  title,
  effectiveDate,
  sections,
}: {
  title: string;
  effectiveDate: string;
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
        <p className="mt-3 text-muted-foreground text-sm">
          Effective date: {effectiveDate}
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
