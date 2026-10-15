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
import { MCP_INTEGRATIONS } from "@/utils/mcp/integrations";

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
    title: "Leave any time",
    description:
      "Disconnect in one step. Your inbox is right where it was, because it never moved.",
  },
];

const MORE_THAN_SORTING = [
  {
    icon: PenLineIcon,
    title: "Replies that sound like you",
    description: "Suggested replies that learn from every edit you make.",
  },
  {
    icon: SunIcon,
    title: "Today",
    description: "What needs a reply, who you're waiting on, and your day.",
  },
  {
    icon: MessageCircleQuestionIcon,
    title: "Ask anything",
    description:
      "Chat that searches your mail, calendar, connected apps and the web.",
  },
  {
    icon: WandSparklesIcon,
    title: "Rules in plain English",
    description: `Tell ${BRAND_NAME} what to do with a kind of email, the way you'd say it.`,
  },
];

type IntegrationTile = { name: string; domain: string; logo?: string };

const INTEGRATION_GROUPS: { label: string; apps: IntegrationTile[] }[] = [
  {
    label: "Classes and files",
    apps: [
      fromConnector("canvas"),
      fromConnector("googledrive"),
      fromConnector("one_drive"),
      fromConnector("googlesheets"),
      fromConnector("airtable"),
    ],
  },
  {
    label: "Chat and tasks",
    apps: [
      fromConnector("slack"),
      { ...fromConnector("microsoft_teams"), name: "Teams" },
      fromConnector("jira"),
      fromConnector("asana"),
      fromConnector("clickup"),
    ],
  },
  {
    label: "Calendar",
    apps: [
      { name: "Google Calendar", domain: "google.com" },
      { name: "Outlook Calendar", domain: "outlook.com" },
      fromConnector("calendly"),
    ],
  },
  {
    label: "Customers and money",
    apps: [
      fromConnector("hubspot"),
      fromConnector("salesforce"),
      fromConnector("zendesk"),
      fromConnector("quickbooks"),
    ],
  },
];

const FAQS: { question: string; answer: string }[] = [
  {
    question: "Do I have to leave Gmail?",
    answer: `No. ${BRAND_NAME} works on top of the Gmail account you already have. Your mail stays in Gmail, nothing is migrated, and Gmail keeps working everywhere you use it. ${BRAND_NAME}'s tabs and sorting live inside ${BRAND_NAME}, so it doesn't label, move or filter anything in Gmail unless you set up a rule that does. You can disconnect any time.`,
  },
  {
    question: `How is ${BRAND_NAME} different from other AI email apps like Superhuman?`,
    answer: `Superhuman is a fast, polished email app with years of work behind it, Outlook support and mobile apps. Its integrations lean toward sales tools like CRMs. ${BRAND_NAME} is built for students, freelancers, founders and small teams. It connects your email to tools like Canvas, Google Drive, Slack, Jira and Asana, and shows what each email needs with the related files, assignments, messages and tasks next to it. Put simply: Superhuman connects your email to your sales tools. ${BRAND_NAME} connects it to everything else. (Based on Superhuman's public website, October 2026.)`,
  },
  {
    question: `Who is ${BRAND_NAME} for?`,
    answer: `Anyone who isn't inside a large enterprise: students, individuals, freelancers, founders and small teams. If you live in Gmail and your work is spread across other apps, ${BRAND_NAME} is for you.`,
  },
  {
    question: `What does ${BRAND_NAME} do with my email?`,
    answer: `${BRAND_NAME} reads your mail to write each email's next step, find related context and suggest replies. Parts of your mail are processed by AI providers to do that, and your mail is never used to train AI models. Nothing sends without you.`,
  },
  {
    question: "Does it work with Outlook?",
    answer: `Not yet. ${BRAND_NAME} works with Gmail accounts today. You can connect an Outlook calendar.`,
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
      description={`A list of messages, newest first, and the rest is up to you: what each one wants, where the file is, what your team already said. ${BRAND_NAME} does a lot more than sorting. It tells you what every email needs and brings everything related to it.`}
    >
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
      title="Connected to everything else you use."
      description={`${BRAND_NAME} connects your email to your classes, files, chats, tasks and calendar, then shows what's related next to each email: the assignment, the doc, the thread, the ticket.`}
    >
      <div className="space-y-6">
        {INTEGRATION_GROUPS.map((group) => (
          <div key={group.label}>
            <h3 className="font-medium text-muted-foreground text-sm">
              {group.label}
            </h3>
            <ul className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
              {group.apps.map((app) => (
                <li
                  key={app.name}
                  className="flex min-w-0 items-center gap-2.5 rounded-lg border bg-card px-3 py-2.5"
                >
                  <ConnectorLogo
                    logo={app.logo}
                    domain={app.domain}
                    size={20}
                  />
                  <span className="truncate text-foreground text-sm">
                    {app.name}
                  </span>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
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

function fromConnector(key: keyof typeof MCP_INTEGRATIONS): IntegrationTile {
  const connector = MCP_INTEGRATIONS[key];
  return {
    name: connector.displayName,
    domain: connector.url,
    logo: connector.logo,
  };
}
