import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/LegalPage";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";

export const metadata: Metadata = {
  title: getBrandTitle("Terms"),
  description: `The terms for using ${BRAND_NAME}.`,
  alternates: { canonical: "/terms" },
};

const linkClass = "underline underline-offset-4 hover:text-foreground";

// DRAFT: placeholders in [BRACKETS] must be resolved by the founder before
// this is deployed.
export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of service"
      effectiveDate="[EFFECTIVE DATE]"
      sections={[
        {
          heading: "About these terms",
          body: (
            <p>
              These terms are an agreement between you and [OPERATOR LEGAL NAME]
              (&quot;we&quot;, &quot;us&quot;), [OPERATOR ADDRESS], for your use
              of {BRAND_NAME}, an AI email client. By signing in or using{" "}
              {BRAND_NAME} you agree to them. If you do not agree, do not use{" "}
              {BRAND_NAME}. Our{" "}
              <Link href="/privacy" className={linkClass}>
                privacy policy
              </Link>{" "}
              explains how we handle your data.
            </p>
          ),
        },
        {
          heading: `${BRAND_NAME} is a private beta`,
          body: (
            <>
              <p>
                {BRAND_NAME} is pre-release software offered to invited users.
                It is provided &quot;as is&quot; and &quot;as available&quot;,
                without warranties of any kind, express or implied, including
                merchantability, fitness for a particular purpose, accuracy and
                non-infringement. Features may change or disappear, data may be
                lost, and the service may be unavailable. Do not rely on{" "}
                {BRAND_NAME} as your only copy of anything or for critical
                communications. Keep your mail in Gmail or Outlook as the source
                of truth.
              </p>
              <p>
                Access is personal to the account that was approved. Do not
                share or transfer it.
              </p>
            </>
          ),
        },
        {
          heading: "Your account and your mail",
          body: (
            <p>
              You must be at least 16 and able to form a binding contract. You
              are responsible for your account and for activity on it. You keep
              ownership of your mail, calendar and other content (&quot;Your
              Content&quot;). You give us permission to access and process Your
              Content only as needed to provide {BRAND_NAME} to you, as
              described in the privacy policy. Make sure you have the right to
              connect the accounts you connect. For example, do not connect a
              work mailbox if your employer does not allow it.
            </p>
          ),
        },
        {
          heading: "AI output can be wrong",
          body: (
            <>
              <p>
                {BRAND_NAME} uses AI to summarize mail, categorize it, suggest
                replies and answer questions. AI output can be inaccurate,
                incomplete, out of date or inappropriate, and it can miss
                things. Review it before you act on it.
              </p>
              <p>
                {BRAND_NAME} does not send its drafts for you. A suggested reply
                is saved as a draft and goes out only when you choose to send
                it. The exception is automation rules: if you set up a rule that
                replies, sends or forwards mail automatically, {BRAND_NAME} will
                do so, and you are responsible for that rule and what it sends.
                You are responsible for everything sent from your account,
                whether you wrote it, edited an AI draft, or approved an
                automation.
              </p>
            </>
          ),
        },
        {
          heading: "Acceptable use",
          body: (
            <>
              <p>Do not use {BRAND_NAME} to:</p>
              <ul className="list-disc space-y-1 pl-5">
                <li>
                  break the law or anyone&apos;s rights, or send spam, phishing,
                  malware or harassing, deceptive or abusive messages;
                </li>
                <li>
                  access mail or accounts that are not yours or that you are not
                  authorized to connect;
                </li>
                <li>
                  probe, attack, overload or disrupt {BRAND_NAME}, or bypass its
                  limits or security;
                </li>
                <li>
                  reverse engineer {BRAND_NAME}, scrape it, or resell access to
                  it;
                </li>
                <li>
                  use it to build a competing model or to train AI models;
                </li>
                <li>upload content you have no right to process.</li>
              </ul>
            </>
          ),
        },
        {
          heading: "Third-party services",
          body: (
            <p>
              {BRAND_NAME} works with services we do not control, such as
              Google, Microsoft, AI providers, hosting providers and any
              integrations you connect. Your use of them is subject to their own
              terms and policies. We are not responsible for their availability,
              changes or actions, and outages or changes on their side may
              affect {BRAND_NAME}.
            </p>
          ),
        },
        {
          heading: "Fees",
          body: (
            <p>
              {BRAND_NAME} is free during the beta. We may introduce fees or
              limits later. If we do, we will give you notice first, and you
              will not be charged unless you agree to a paid plan.
            </p>
          ),
        },
        {
          heading: "Ending access",
          body: (
            <p>
              You can stop using {BRAND_NAME} and delete your account in
              Settings at any time, and you can revoke {BRAND_NAME}&apos;s
              access in your Google or Microsoft account. We may suspend or end
              your access, with notice where we reasonably can, for example if
              you break these terms, if your use puts others or the service at
              risk, or if we end the beta. When access ends, the privacy
              policy&apos;s retention and deletion terms apply. Sections that by
              their nature should survive (such as disclaimers, liability,
              indemnity and governing law) do.
            </p>
          ),
        },
        {
          heading: "Limitation of liability",
          body: (
            <p>
              To the fullest extent the law allows, we are not liable for
              indirect, incidental, special, consequential or punitive damages,
              or for lost profits, revenue, data, goodwill or business
              opportunities, arising from or related to {BRAND_NAME}, including
              mistaken or unsent messages, missed mail, or AI errors. Our total
              liability for any claim relating to {BRAND_NAME} is limited to the
              greater of the amount you paid us in the 12 months before the
              claim (zero during the free beta) and US$100. Some places do not
              allow certain limits, so these may apply to you only as far as the
              law permits. Nothing here limits liability that cannot be limited
              by law.
            </p>
          ),
        },
        {
          heading: "Indemnity",
          body: (
            <p>
              You will defend and compensate us against claims, losses and costs
              (including reasonable legal fees) arising from your misuse of{" "}
              {BRAND_NAME}, Your Content, messages sent from your account, or
              your breach of these terms or the law, except to the extent caused
              by us.
            </p>
          ),
        },
        {
          heading: "Governing law",
          body: (
            <p>
              These terms are governed by the laws of [GOVERNING LAW
              JURISDICTION], without regard to conflict-of-law rules. Disputes
              will be brought in the courts of [VENUE / COURTS], unless the law
              of your place of residence requires otherwise. Please contact us
              first and give us a chance to resolve a problem informally.
            </p>
          ),
        },
        {
          heading: "Changes",
          body: (
            <p>
              We may update these terms and the service. For material changes we
              will tell you in the app or by email before they take effect. If
              you keep using {BRAND_NAME} after that, you accept the new terms.
              If you do not agree, stop using {BRAND_NAME} and delete your
              account.
            </p>
          ),
        },
        {
          heading: "General",
          body: (
            <p>
              These terms and the privacy policy are the whole agreement between
              us about {BRAND_NAME}. If part of them is unenforceable, the rest
              stays in effect. Not enforcing a term is not a waiver of it. You
              may not assign these terms; we may assign them as part of a sale
              or reorganization.
            </p>
          ),
        },
        {
          heading: "Contact",
          body: (
            <p>
              [OPERATOR LEGAL NAME], [OPERATOR ADDRESS]
              <br />
              Email: [SUPPORT CONTACT EMAIL]
            </p>
          ),
        },
      ]}
    />
  );
}
