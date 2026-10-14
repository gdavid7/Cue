import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/LegalPage";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Terms"),
  description: `The terms for using ${BRAND_NAME}.`,
  alternates: { canonical: "/terms" },
};

// PLACEHOLDER: the founder replaces this text (plan decision D9).
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      sections={[
        {
          heading: "The private beta",
          body: (
            <p>
              {BRAND_NAME} is in private beta. Access is personal to the Google
              account that was approved and can&apos;t be shared or transferred.
              Features may change, and the service may be unavailable at times.
            </p>
          ),
        },
        {
          heading: "Your account and your mail",
          body: (
            <p>
              You keep ownership of your mail and data. You allow {BRAND_NAME}{" "}
              to process it only to provide the service to you, as described in
              the{" "}
              <Link href="/privacy" className="underline underline-offset-4">
                privacy policy
              </Link>
              .
            </p>
          ),
        },
        {
          heading: "Suggested replies",
          body: (
            <p>
              {BRAND_NAME} drafts replies and notes with AI. They can be wrong.
              Nothing sends without you, and you are responsible for what you
              send.
            </p>
          ),
        },
        {
          heading: "Acceptable use",
          body: (
            <p>
              Don&apos;t use {BRAND_NAME} to send spam, break the law, or access
              mail that isn&apos;t yours. [Placeholder: full list.]
            </p>
          ),
        },
        {
          heading: "Ending access",
          body: (
            <p>
              You can stop using {BRAND_NAME} and delete your account at any
              time. We may end beta access, with notice where we can.
            </p>
          ),
        },
        {
          heading: "Disclaimers and liability",
          body: (
            <p>
              [Placeholder: warranty disclaimer and limitation of liability.]
            </p>
          ),
        },
        {
          heading: "Contact",
          body: <p>[Placeholder: contact address.]</p>,
        },
      ]}
    />
  );
}
