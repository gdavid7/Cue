import {
  ChevronDownIcon,
  InboxIcon,
  LogOutIcon,
  MessageCircleQuestionIcon,
  PenLineIcon,
  ShieldCheckIcon,
  SunIcon,
  TagIcon,
  WandSparklesIcon,
} from "lucide-react";
import { ConnectorLogo } from "@/components/connectors/ConnectorLogo";
import { IntelligenceDemo } from "@/app/(landing)/login/IntelligenceDemo";
import { BRAND_NAME } from "@/utils/branding";

const KEEP_GMAIL_POINTS = [
  {
    icon: InboxIcon,
    title: "Your mail stays in Gmail",
    description:
      "Nothing is migrated. Gmail keeps working on your phone and everywhere else.",
  },
  {
    icon: TagIcon,
    title: "Your Gmail stays as you left it",
    description: `${BRAND_NAME}'s tabs and sorting live inside ${BRAND_NAME}. It doesn't label, move or filter mail in Gmail unless you set up a rule that does.`,
  },
  {
    icon: ShieldCheckIcon,
    title: "Nothing sends without you",
    description: `${BRAND_NAME} suggests replies. You decide what goes out. Your mail is never used to train AI models.`,
  },
  {
    icon: LogOutIcon,
    title: "Stop any time",
    description: `If you stop using ${BRAND_NAME}, nothing changes. Your emails were in Gmail all along.`,
  },
];

const MORE_THAN_SORTING = [
  {
    icon: PenLineIcon,
    title: "Replies that sound like you",
    description: "Suggested replies that learn from your edits.",
  },
  {
    icon: SunIcon,
    title: "Today",
    description: "What needs a reply, who you're waiting on, and your day.",
  },
  {
    icon: MessageCircleQuestionIcon,
    title: "Ask anything",
    description: "Chat that searches your mail and calendar.",
  },
  {
    icon: WandSparklesIcon,
    title: "Rules in plain English",
    description: `Tell ${BRAND_NAME} what to do with a kind of email, the way you'd say it.`,
  },
];

type IntegrationTile = { name: string; domain: string };

const INTEGRATIONS: IntegrationTile[] = [
  { name: "Gmail", domain: "gmail.com" },
  { name: "Google Calendar", domain: "google.com" },
];

const FAQS: { question: string; answer: string }[] = [
  {
    question: "Do I have to leave Gmail?",
    answer: `No. ${BRAND_NAME} works on top of the Gmail account you already have. Your mail stays in Gmail, nothing is migrated, and Gmail keeps working everywhere you use it. ${BRAND_NAME}'s tabs and sorting live inside ${BRAND_NAME}, so it doesn't label, move or filter anything in Gmail unless you set up a rule that does. You can disconnect any time.`,
  },
  {
    question: `Who is ${BRAND_NAME} for?`,
    answer:
      "Students, freelancers, founders and small teams who live in Gmail.",
  },
  {
    question: `What does ${BRAND_NAME} do with my email?`,
    answer: `${BRAND_NAME} reads your mail to tell you what most emails need from you and to suggest replies. Parts of your mail are processed by AI providers to do that, and your mail is never used to train AI models. Nothing sends without you.`,
  },
  {
    question: "Does it work with Outlook?",
    answer: `Not yet. ${BRAND_NAME} works with Gmail accounts today.`,
  },
  {
    question: "Why is there a waitlist?",
    answer:
      "We let people in a few at a time and review every request personally, so we can help everyone who joins.",
  },
];

export function KeepGmailSection() {
  return (
    <LandingSection
      id="keep-gmail"
      title="You keep Gmail."
      description={`${BRAND_NAME} works on top of the Gmail account you already have. There's nothing to move and nothing to give up.`}
    >
      <ul className="grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {KEEP_GMAIL_POINTS.map((point) => (
          <FeatureItem key={point.title} {...point} />
        ))}
      </ul>
    </LandingSection>
  );
}

export function IntelligenceSection() {
  return (
    <LandingSection
      id="intelligence"
      title="Email has worked the same way for over 50 years."
      description={`A list of messages, newest first, and the rest is up to you: what each one wants and what to say back. ${BRAND_NAME} does a lot more than sorting. It tells you what most emails need from you, like “Reply with your flight time” or “Confirm Wednesday 4 PM”, right under the email.`}
    >
      <h3 className="mb-3 font-medium text-foreground">
        Intelligence, not just sorting.
      </h3>
      <IntelligenceDemo />
      <ul className="mt-10 grid gap-x-8 gap-y-6 sm:grid-cols-2">
        {MORE_THAN_SORTING.map((item) => (
          <FeatureItem key={item.title} {...item} />
        ))}
      </ul>
    </LandingSection>
  );
}

export function IntegrationsSection() {
  return (
    <LandingSection
      id="integrations"
      title="Works with Gmail and Google Calendar."
      description={`${BRAND_NAME} reads your Gmail and your calendar to understand what each email needs. More connections are coming.`}
    >
      <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {INTEGRATIONS.map((app) => (
          <li
            key={app.name}
            className="flex min-w-0 items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5"
          >
            <ConnectorLogo domain={app.domain} size={20} />
            <span className="truncate text-foreground text-sm">{app.name}</span>
          </li>
        ))}
      </ul>
    </LandingSection>
  );
}

export function FaqSection() {
  return (
    <LandingSection id="faq" title="Questions">
      <div className="divide-y rounded-xl border bg-card">
        {FAQS.map((faq, index) => (
          // The two questions skeptical visitors ask most start open.
          <details key={faq.question} className="group" open={index < 2}>
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-4 py-4 font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:px-5 [&::-webkit-details-marker]:hidden">
              {faq.question}
              <ChevronDownIcon
                className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180 motion-reduce:transition-none"
                aria-hidden
              />
            </summary>
            <p className="px-4 pb-4 text-muted-foreground leading-relaxed sm:px-5">
              {faq.answer}
            </p>
          </details>
        ))}
      </div>
    </LandingSection>
  );
}

function LandingSection({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <section aria-labelledby={`${id}-heading`} className="lg:col-span-2">
      <h2
        id={`${id}-heading`}
        className="max-w-2xl font-title text-2xl text-foreground leading-tight tracking-tight sm:text-3xl"
      >
        {title}
      </h2>
      {description && (
        <p className="mt-3 max-w-2xl text-muted-foreground leading-relaxed">
          {description}
        </p>
      )}
      <div className="mt-8">{children}</div>
    </section>
  );
}

function FeatureItem({
  icon: Icon,
  title,
  description,
}: {
  icon: React.ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  title: string;
  description: string;
}) {
  return (
    <li className="flex gap-3">
      <Icon
        className="mt-0.5 size-5 shrink-0 text-muted-foreground"
        aria-hidden
      />
      <p className="leading-snug">
        <span className="font-medium text-foreground">{title}</span>
        <span className="sr-only"> — </span>
        <span className="mt-1 block text-muted-foreground text-sm">
          {description}
        </span>
      </p>
    </li>
  );
}
