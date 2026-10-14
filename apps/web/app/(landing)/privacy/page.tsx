import type { Metadata } from "next";
import { LegalPage } from "@/components/LegalPage";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Privacy"),
  description: `How ${BRAND_NAME} handles your data.`,
  alternates: { canonical: "/privacy" },
};

// PLACEHOLDER: the founder replaces this text (plan decision D9).
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      sections={[
        {
          heading: "What we collect",
          body: (
            <>
              <p>
                When you request access: the Gmail address you enter, when you
                asked, and whether you asked through the form or by trying to
                sign in.
              </p>
              <p>
                When you sign in: your name, email address and profile picture
                from Google, and the mail, calendar and (if you allow it)
                contacts data {BRAND_NAME} needs to work for you.
              </p>
            </>
          ),
        },
        {
          heading: "How we use your Gmail and calendar data",
          body: (
            <p>
              Only to provide {BRAND_NAME}&apos;s features to you: showing what
              needs your reply, writing reply drafts, preparing briefs and
              answering your questions. {BRAND_NAME} doesn&apos;t move, label or
              filter anything in Gmail by default, and nothing sends without
              you.
            </p>
          ),
        },
        {
          heading: "AI and training",
          body: (
            <p>
              Parts of your mail are processed by AI providers to produce notes
              and drafts for you. Your mail is never used to train AI models,
              ours or anyone else&apos;s.
            </p>
          ),
        },
        {
          heading: "Google API Services User Data Policy",
          body: (
            <p>
              {BRAND_NAME}&apos;s use and transfer of information received from
              Google APIs to any other app will adhere to the{" "}
              <a
                href="https://developers.google.com/terms/api-services-user-data-policy"
                className="underline underline-offset-4 hover:text-foreground"
              >
                Google API Services User Data Policy
              </a>
              , including the Limited Use requirements.
            </p>
          ),
        },
        {
          heading: "Storage and sub-processors",
          body: (
            <p>
              [Placeholder: where data is stored, and the list of sub-processors
              such as hosting, database and AI providers.]
            </p>
          ),
        },
        {
          heading: "Retention",
          body: (
            <p>
              Access requests that are never approved, or are declined, are
              deleted after 12 months. Account data is kept while your account
              exists. [Placeholder: confirm periods.]
            </p>
          ),
        },
        {
          heading: "Deleting your data",
          body: (
            <p>
              You can delete your account from Settings, which removes your data
              from {BRAND_NAME}. You can also remove {BRAND_NAME}&apos;s access
              at any time from your Google account&apos;s security settings.
            </p>
          ),
        },
        {
          heading: "Contact",
          body: <p>[Placeholder: privacy contact address.]</p>,
        },
      ]}
    />
  );
}
