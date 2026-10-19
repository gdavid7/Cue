import type { Metadata } from "next";
import Link from "next/link";
import { LegalPage } from "@/components/LegalPage";
import { BRAND_NAME, getBrandTitle } from "@/utils/branding";
import { LEGAL } from "@/utils/legal";

export const metadata: Metadata = {
  title: getBrandTitle("Privacy"),
  description: `How ${BRAND_NAME} handles your data.`,
  alternates: { canonical: "/privacy" },
};

const linkClass = "underline underline-offset-4 hover:text-foreground";
const listClass = "list-disc space-y-1 pl-5";

// Subprocessors and retention below match the code and the providers the
// operator confirmed are in use. Sentry, PostHog, Resend, Loops and Tinybird
// have code paths but are deliberately not listed; add them back here (and to
// the collection and deletion text) if any is enabled in production.
// The AI training statement assumes paid API access with Anthropic and Google;
// Gemini's free tier can use inputs for training, so keep it on a paid plan.
export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy policy"
      effectiveDate={LEGAL.effectiveDate}
      sections={[
        {
          heading: "Who we are",
          body: (
            <>
              <p>
                {BRAND_NAME} is an AI email client operated by{" "}
                {LEGAL.operatorLegalName} (&quot;we&quot;, &quot;us&quot;),{" "}
                {LEGAL.operatorAddress}. {BRAND_NAME} is in private beta. This
                policy explains what data {BRAND_NAME} handles, why, and what
                control you have.
              </p>
              <ul className={listClass}>
                <li>
                  {BRAND_NAME} reads your mail and calendar to show what needs a
                  reply, write draft replies, prepare briefs and answer your
                  questions.
                </li>
                <li>
                  We do not sell your data, show ads, or use your Google data to
                  train AI models.
                </li>
                <li>
                  Drafts are not sent unless you send them, or you set up an
                  automation rule that does.
                </li>
                <li>You can disconnect or delete your account at any time.</li>
              </ul>
            </>
          ),
        },
        {
          heading: "What we collect and why",
          body: (
            <ul className={listClass}>
              <li>
                <strong className="text-foreground">Account details.</strong>{" "}
                Your name, email address and profile picture from Google or
                Microsoft when you sign in, and the address you enter when you
                request access. Used to run your account and manage who is
                invited to the beta.
              </li>
              <li>
                <strong className="text-foreground">Mail data.</strong>{" "}
                Messages, threads, labels, attachments and drafts in your
                connected mailbox. Used to show your inbox, find what needs a
                reply, write drafts, categorize mail, and run automations you
                configure. On our servers {BRAND_NAME} stores message metadata
                (sender, recipients, dates, read state, thread IDs). Message
                content is fetched from Gmail or Microsoft when needed and is
                kept in a local mail cache in your browser. Content can also be
                stored where it is part of something {BRAND_NAME} produced for
                you, such as a draft, a note, a chat answer, or the reason a
                rule ran, and for emails you send or schedule while they are
                held for undo or sending. Our Redis cache holds no message
                content or personal data: only IDs, hashes, counters, locks and
                timestamps that keep sync, rate limits and background jobs
                running, and public news headlines about the organizations you
                meet, stored under a hash of the organization. Briefs, suggested
                replies, inbox insights and contact photos that {BRAND_NAME}{" "}
                works out for you are sent to your browser and kept there, next
                to your local mail cache. Messages in our job queue carry the
                IDs, and for sorting senders the sender addresses, that a
                background job needs, until the job runs.
              </li>
              <li>
                <strong className="text-foreground">Calendar data.</strong>{" "}
                Events and free/busy times, used for briefs, scheduling and
                availability. {BRAND_NAME} creates or changes events only when
                you ask.
              </li>
              <li>
                <strong className="text-foreground">Contacts.</strong> If
                enabled and you allow it, your saved contacts and people you
                correspond with, used to suggest recipients and give context
                about people.
              </li>
              <li>
                <strong className="text-foreground">
                  Things you create in {BRAND_NAME}.
                </strong>{" "}
                Rules and automations, writing-style and signature settings,
                memories and learned reply preferences, chat history with the
                assistant, and other settings.
              </li>
              <li>
                <strong className="text-foreground">Connected services.</strong>{" "}
                If you connect integrations (for example MCP servers, Slack,
                Notion or a separate calendar), {BRAND_NAME} stores the
                connection and its access tokens, and sends those services only
                what a feature you use requires.
              </li>
              <li>
                <strong className="text-foreground">Sign-in tokens.</strong>{" "}
                OAuth access and refresh tokens, so {BRAND_NAME} can reach your
                mailbox without you signing in each time.
              </li>
              <li>
                <strong className="text-foreground">
                  Usage and technical data.
                </strong>{" "}
                Server logs and error details. Used to keep {BRAND_NAME} secure
                and working. {BRAND_NAME} uses essential cookies for sign-in and
                to remember your selected mailbox.
              </li>
            </ul>
          ),
        },
        {
          heading: "Permissions we request",
          body: (
            <>
              <p>
                <strong className="text-foreground">Google:</strong> view and
                manage your mail (gmail.modify: read, label, archive, create
                drafts, and send when you tell it to), manage basic mail
                settings (gmail.settings.basic), read and edit calendar events
                and free/busy (calendar.readonly, calendar.events,
                calendar.freebusy), your basic profile and email, and, if
                enabled, contacts (contacts, contacts.other.readonly). If you
                connect Google Drive for attachment filing, we also ask for
                access to files created by or opened with {BRAND_NAME}
                (drive.file).
              </p>
              <p>
                <strong className="text-foreground">
                  Microsoft (if you connect a Microsoft account):
                </strong>{" "}
                read and write your mail (Mail.ReadWrite, plus Mail.Send when
                sending is enabled), mailbox settings, calendars, basic profile,
                offline access for refresh tokens, and, if enabled, contacts and
                people.
              </p>
              <p>
                We ask only for what {BRAND_NAME}&apos;s features use. You can
                revoke access at any time (see below).
              </p>
            </>
          ),
        },
        {
          heading: "How AI processing works",
          body: (
            <>
              <p>
                When a feature needs AI, {BRAND_NAME} sends the relevant text to
                an AI provider&apos;s API and gets a result back: a summary, a
                draft, a category, an answer. What is sent depends on the
                feature. It can include a message or thread, calendar details,
                your instruction, and your saved preferences. {BRAND_NAME}{" "}
                currently uses Anthropic as its primary AI provider and Google
                (Gemini) as a fallback.
              </p>
              <p>
                {BRAND_NAME} uses these providers through their APIs. We do not
                authorize them to train models on your data, and their API terms
                govern how they handle what we send.
              </p>
              <p>
                We do not use your mail or other Google user data to develop,
                improve or train generalized AI models, ours or anyone
                else&apos;s. AI output can be wrong; see our{" "}
                <Link href="/terms" className={linkClass}>
                  terms
                </Link>
                .
              </p>
            </>
          ),
        },
        {
          heading: "Google API Services User Data Policy (Limited Use)",
          body: (
            <>
              <p>
                {BRAND_NAME}&apos;s use and transfer of information received
                from Google APIs to any other app will adhere to the{" "}
                <a
                  href="https://developers.google.com/terms/api-services-user-data-policy"
                  className={linkClass}
                >
                  Google API Services User Data Policy
                </a>
                , including the Limited Use requirements.
              </p>
              <p>In particular, for data we receive from Google APIs:</p>
              <ul className={listClass}>
                <li>
                  We use it only to provide or improve user-facing features that
                  are visible in {BRAND_NAME}, such as showing your inbox,
                  writing drafts and preparing briefs.
                </li>
                <li>
                  We do not sell it, and we do not transfer it to others except
                  as needed to provide those features (for example to the AI and
                  hosting providers listed below), to comply with law, or as
                  part of a merger or sale where you are told first.
                </li>
                <li>
                  We do not use it for advertising, including retargeting or
                  interest-based ads.
                </li>
                <li>
                  We do not use it to develop, improve or train generalized AI
                  or machine-learning models.
                </li>
                <li>
                  No human reads it, except with your explicit consent for
                  specific messages, where needed for security (for example
                  investigating abuse or a fault in your own account), or where
                  required by law.
                </li>
              </ul>
            </>
          ),
        },
        {
          heading: "Who we share data with (subprocessors)",
          body: (
            <>
              <p>
                These providers help us run {BRAND_NAME} and process data on our
                behalf.
              </p>
              <ul className={listClass}>
                <li>Vercel: application hosting</li>
                <li>Neon: Postgres database</li>
                <li>Upstash: Redis cache (no message content) and job queue</li>
                <li>Anthropic: AI processing (primary)</li>
                <li>Google (Gemini API): AI processing (fallback)</li>
                <li>
                  Google (and Microsoft, if you connect a Microsoft account):
                  the Gmail, Calendar, Contacts and Graph APIs you authorize
                </li>
                <li>Axiom: application logs</li>
                <li>
                  Integrations you connect (Slack, Notion, MCP servers and
                  similar): only when you connect them
                </li>
              </ul>
              <p>
                We may also disclose data if the law requires it. Data may be
                processed in the United States and other countries where these
                providers operate.
              </p>
            </>
          ),
        },
        {
          heading: "Retention and deletion",
          body: (
            <>
              <ul className={listClass}>
                <li>
                  Account data and mail metadata: kept while your account
                  exists.
                </li>
                <li>
                  Browser mail cache, and the briefs, suggested replies and
                  insights kept with it: live in your browser and are cleared
                  when you sign out.
                </li>
                <li>
                  Sent-draft text captured to compare a draft with what you
                  sent: removed after 14 days.
                </li>
                <li>
                  AI reasoning notes on automation history: kept with that
                  history, and we may redact them after a set period.
                </li>
                <li>
                  Unedited AI drafts left in your mailbox: removed after the
                  number of days in your settings (default 14).
                </li>
                <li>
                  Send-operation records (used to prevent double sends and
                  support undo): removed about 30 days after they finish.
                </li>
                <li>Mobile push delivery records: removed after 24 hours.</li>
                <li>
                  Chat history and memories: kept until you delete them or
                  delete your account.
                </li>
                <li>
                  Logs: kept for a limited period by our logging provider
                  (Axiom).
                </li>
                <li>
                  Backups: deleted data may remain in our database
                  provider&apos;s backups until they expire.
                </li>
              </ul>
              <p>
                <strong className="text-foreground">
                  Deleting your account.
                </strong>{" "}
                In Settings you can delete your account. This removes your{" "}
                {BRAND_NAME} data and stops mailbox notifications. You can also
                delete a single connected mailbox.
              </p>
              <p>
                <strong className="text-foreground">Disconnecting.</strong> You
                can remove {BRAND_NAME} from your Google account&apos;s
                third-party access settings or your Microsoft account&apos;s app
                permissions at any time. {BRAND_NAME} then loses access to the
                mailbox. Use Settings to delete the data we hold.
              </p>
            </>
          ),
        },
        {
          heading: "Security",
          body: (
            <p>
              Traffic uses HTTPS, OAuth tokens are encrypted before they are
              stored, and mail content is fetched on demand rather than copied
              wholesale into our database. No system is perfectly secure, and{" "}
              {BRAND_NAME} is run by one person during the beta, so we cannot
              promise enterprise-grade controls. Tell us promptly if you suspect
              a problem.
            </p>
          ),
        },
        {
          heading: "Your rights",
          body: (
            <>
              <p>
                Depending on where you live (for example the EU or UK under
                GDPR, or California under CCPA/CPRA), you may have the right to
                access, correct, delete or export your personal data, to
                restrict or object to its use, and to withdraw consent. We do
                not sell or share personal data for advertising. You can delete
                your account yourself in Settings. For anything else, including
                an export, email us and we will respond within 30 days. You may
                also complain to your local data protection authority.
              </p>
              <p>
                Where GDPR applies, our legal bases are performing our contract
                with you (running {BRAND_NAME}), your consent (connecting your
                accounts), and our legitimate interests (security and improving{" "}
                {BRAND_NAME}).
              </p>
            </>
          ),
        },
        {
          heading: "Children",
          body: (
            <p>
              {BRAND_NAME} is not for anyone under 16. We do not knowingly
              collect data from children. If you believe we have, contact us and
              we will delete it.
            </p>
          ),
        },
        {
          heading: "Changes",
          body: (
            <p>
              We may update this policy. For material changes we will tell you
              in the app or by email before they take effect. The effective date
              above shows the latest version.
            </p>
          ),
        },
        {
          heading: "Contact",
          body: (
            <p>
              {LEGAL.operatorLegalName}, {LEGAL.operatorAddress}
              <br />
              Email: {LEGAL.privacyContactEmail}
            </p>
          ),
        },
      ]}
    />
  );
}
