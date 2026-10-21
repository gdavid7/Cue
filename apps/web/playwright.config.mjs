import fs from "node:fs";
import { createServer } from "node:net";
import path from "node:path";
import { defineConfig } from "@playwright/test";

const allocatedPorts = new Set();
const production = process.env.PLAYWRIGHT_PRODUCTION === "1";
if (production && !process.env.NEXT_PUBLIC_BASE_URL) {
  throw new Error(
    "Production Playwright requires NEXT_PUBLIC_BASE_URL to match the URL used for next build.",
  );
}
const baseURL =
  process.env.NEXT_PUBLIC_BASE_URL ??
  `http://localhost:${await getAvailablePort()}`;
const basePort = getUrlPort(baseURL);
const databaseUrl =
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5433/postgres";
const mailProvider =
  process.env.PLAYWRIGHT_MAIL_PROVIDER === "microsoft" ? "microsoft" : "google";
const emulateBaseUrl =
  (mailProvider === "microsoft"
    ? process.env.MICROSOFT_BASE_URL
    : process.env.GOOGLE_BASE_URL) ??
  `http://localhost:${await getAvailablePort()}`;
const emulatePort = getUrlPort(emulateBaseUrl);
const microsoftClientId =
  process.env.MICROSOFT_CLIENT_ID ?? "emulate-microsoft-client-id";
const microsoftClientSecret =
  process.env.MICROSOFT_CLIENT_SECRET ?? "emulate-microsoft-secret";
const microsoftWebhookClientState =
  process.env.MICROSOFT_WEBHOOK_CLIENT_STATE ?? "playwright-microsoft-webhook";
// Google runs also start a Microsoft emulator holding a separate Outlook
// mailbox, so a spec can link Outlook to a Google user as production allows.
const linkedMicrosoftBaseUrl =
  mailProvider === "google"
    ? (process.env.MICROSOFT_BASE_URL ??
      `http://localhost:${await getAvailablePort()}`)
    : undefined;
const emailBaseUrl =
  process.env.PLAYWRIGHT_EMAIL_BASE_URL ??
  `http://127.0.0.1:${await getAvailablePort()}`;
const emailPort = getUrlPort(emailBaseUrl);
process.env.PLAYWRIGHT_EMAIL_BASE_URL = emailBaseUrl;
const stripeBaseUrl =
  process.env.PLAYWRIGHT_STRIPE_BASE_URL ??
  `http://127.0.0.1:${await getAvailablePort()}`;
const stripePort = getUrlPort(stripeBaseUrl);
// Set PLAYWRIGHT_LLM_BASE_URL to run against an external OpenAI-compatible
// server (serving a model named `emulated`) instead of the in-repo emulator.
const externalLlmBaseUrl = process.env.PLAYWRIGHT_LLM_BASE_URL;
const llmBaseUrl =
  externalLlmBaseUrl ?? `http://127.0.0.1:${await getAvailablePort()}`;
const llmPort = getUrlPort(llmBaseUrl);
const llmModelName = "emulated";
const stripeSecretKey = "playwright-stripe-key";
// The emulator accepts any price id; these only have to match what the app was
// built with so the tier lookup resolves.
const stripeEmulatorPriceIds = {
  NEXT_PUBLIC_STRIPE_BUSINESS_MONTHLY_PRICE_ID:
    "price_playwright_starter_monthly",
  NEXT_PUBLIC_STRIPE_BUSINESS_ANNUALLY_PRICE_ID:
    "price_playwright_starter_annually",
  NEXT_PUBLIC_STRIPE_PLUS_MONTHLY_PRICE_ID: "price_playwright_plus_monthly",
  NEXT_PUBLIC_STRIPE_PLUS_ANNUALLY_PRICE_ID: "price_playwright_plus_annually",
  NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_MONTHLY_PRICE_ID:
    "price_playwright_professional_monthly",
  NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_ANNUALLY_PRICE_ID:
    "price_playwright_professional_annually",
};
const stripeWebhookSecret = "whsec_playwright";
const todoistEnabled = process.env.PLAYWRIGHT_TODOIST_ENABLED === "true";
const todoistBaseUrl = todoistEnabled
  ? `http://localhost:${await getAvailablePort()}`
  : undefined;
const todoistPort = todoistBaseUrl ? getUrlPort(todoistBaseUrl) : undefined;
const internalApiKey = process.env.INTERNAL_API_KEY ?? "secret";
const nodeOptions = process.env.NODE_OPTIONS ?? "--max_old_space_size=6144";
const runId = process.env.PLAYWRIGHT_RUN_ID ?? `${process.pid}-${Date.now()}`;
const playwrightTestEmail =
  process.env.PLAYWRIGHT_TEST_EMAIL ??
  `playwright-test+${runId}@gmail.com`.toLowerCase();
const blobReportFile = process.env.PLAYWRIGHT_BLOB_REPORT_FILE;
const authStatePath = path.join(
  process.cwd(),
  ".tmp",
  "playwright",
  runId,
  "auth.json",
);
// Mailboxes a spec's second account of the user can read, each its own, as
// a real second account is. createSecondEmailAccount hands them out.
const extraMailboxes = [1, 2, 3].map((index) => ({
  email: playwrightTestEmail.replace(/^[^@+]+/, `playwright-mailbox-${index}`),
  token: `playwright_${mailProvider}_mailbox_${index}_token`,
  idSuffix: `__mailbox_${index}`,
}));
const emulateSeedPath = writeEmulateSeed({
  baseURL,
  mailProvider,
  playwrightTestEmail,
  runId,
  extraMailboxes,
});
// Keep in sync with mixed-provider-accounts.spec.ts.
const LINKED_OUTLOOK_CALENDAR_ID = "cal_playwright_linked_design";
const linkedOutlookEmail =
  `playwright-outlook+${runId}@outlook.com`.toLowerCase();
const linkedMicrosoftSeedPath = linkedMicrosoftBaseUrl
  ? writeLinkedMicrosoftSeed({ baseURL, linkedOutlookEmail, runId })
  : undefined;
const emulateCommand =
  process.env.EMULATE_COMMAND ??
  `npx emulate start --service ${mailProvider} --port ${emulatePort} --seed ${emulateSeedPath}`;

fs.mkdirSync(path.dirname(authStatePath), { recursive: true });
process.env.DATABASE_URL = databaseUrl;
if (mailProvider === "microsoft") {
  process.env.MICROSOFT_BASE_URL = emulateBaseUrl;
  process.env.MICROSOFT_CLIENT_ID = microsoftClientId;
  process.env.MICROSOFT_CLIENT_SECRET = microsoftClientSecret;
  process.env.MICROSOFT_WEBHOOK_CLIENT_STATE = microsoftWebhookClientState;
} else {
  process.env.GOOGLE_BASE_URL = emulateBaseUrl;
  process.env.PLAYWRIGHT_LINKED_OUTLOOK_EMAIL = linkedOutlookEmail;
}
process.env.INTERNAL_API_KEY = internalApiKey;
process.env.NEXT_PUBLIC_BASE_URL = baseURL;
process.env.NODE_OPTIONS = nodeOptions;
process.env.PLAYWRIGHT_AUTH_FILE = authStatePath;
process.env.PLAYWRIGHT_RUN_ID = runId;
process.env.PLAYWRIGHT_TEST_EMAIL = playwrightTestEmail;
process.env.PLAYWRIGHT_EXTRA_MAILBOXES = JSON.stringify(extraMailboxes);
process.env.PLAYWRIGHT_MAIL_PROVIDER = mailProvider;
process.env.PLAYWRIGHT_STRIPE_BASE_URL = stripeBaseUrl;
process.env.PLAYWRIGHT_LLM_BASE_URL = llmBaseUrl;
// Only a default. Production runs freeze NEXT_PUBLIC_* into the build, which
// happens in a separate job before this config loads, so those runs must set
// these in the workflow and have their values win here.
for (const [key, priceId] of Object.entries(stripeEmulatorPriceIds)) {
  process.env[key] ??= priceId;
}
if (todoistBaseUrl) {
  process.env.PLAYWRIGHT_TODOIST_BASE_URL = todoistBaseUrl;
}

export default defineConfig({
  testDir: "./__tests__/playwright",
  outputDir: process.env.PLAYWRIGHT_OUTPUT_DIR,
  forbidOnly: !!process.env.CI,
  fullyParallel: false,
  // Every browser test shares one seeded provider and one authenticated account.
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  timeout: 240_000,
  expect: {
    timeout: 20_000,
  },
  reporter: blobReportFile
    ? [
        ...(process.env.CI ? [["github"]] : []),
        ["list"],
        ["blob", { outputFile: blobReportFile }],
      ]
    : [
        ...(process.env.CI ? [["github"]] : []),
        ["list"],
        ["html", { open: "never", outputFolder: "playwright-report" }],
      ],
  use: {
    baseURL,
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "emulated-setup",
      testMatch: ["emulated/setup/**/*.setup.ts"],
    },
    {
      name: "emulated",
      dependencies: ["emulated-setup"],
      testMatch: ["emulated/**/*.spec.ts"],
      use: {
        storageState: authStatePath,
      },
    },
  ],
  webServer: [
    {
      name: "Email emulator",
      stdout: "pipe",
      command: `node __tests__/playwright/email-server.mjs ${emailPort}`,
      cwd: process.cwd(),
      url: emailBaseUrl,
      timeout: 30_000,
    },
    {
      name:
        mailProvider === "microsoft" ? "Microsoft emulator" : "Google emulator",
      stdout: "pipe",
      command: emulateCommand,
      cwd: process.cwd(),
      url: `${emulateBaseUrl}/.well-known/openid-configuration`,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
    },
    ...(linkedMicrosoftBaseUrl && linkedMicrosoftSeedPath
      ? [
          {
            name: "Linked Microsoft emulator",
            stdout: "pipe",
            command: `npx emulate start --service microsoft --port ${getUrlPort(linkedMicrosoftBaseUrl)} --seed ${linkedMicrosoftSeedPath}`,
            cwd: process.cwd(),
            url: `${linkedMicrosoftBaseUrl}/.well-known/openid-configuration`,
            timeout: 240_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
    ...(todoistBaseUrl && todoistPort
      ? [
          {
            name: "Todoist emulator",
            stdout: "pipe",
            command: `pnpm exec tsx scripts/todoist-mcp-emulator.ts ${todoistPort}`,
            cwd: process.cwd(),
            url: `${todoistBaseUrl}/health`,
            timeout: 240_000,
            reuseExistingServer: !process.env.CI,
          },
        ]
      : []),
    {
      name: "Stripe emulator",
      stdout: "pipe",
      command: `pnpm exec tsx scripts/run-stripe-emulator.ts ${stripePort}`,
      cwd: process.cwd(),
      url: `${stripeBaseUrl}/health`,
      timeout: 60_000,
      reuseExistingServer: false,
      env: {
        ...process.env,
        STRIPE_EMULATOR_WEBHOOK_URL: `${baseURL}/api/stripe/webhook`,
        STRIPE_SECRET_KEY: stripeSecretKey,
        STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
      },
    },
    ...(externalLlmBaseUrl
      ? []
      : [
          {
            name: "LLM emulator",
            stdout: "pipe",
            command: `pnpm exec tsx scripts/run-llm-emulator.ts ${llmPort}`,
            cwd: process.cwd(),
            url: `${llmBaseUrl}/health`,
            timeout: 60_000,
            reuseExistingServer: false,
            env: { ...process.env, LLM_EMULATOR_MODEL: llmModelName },
          },
        ]),
    {
      name: "Next.js",
      stdout: "pipe",
      command: `${
        todoistEnabled
          ? "node --import ./__tests__/playwright/todoist-preload.mjs node_modules/next/dist/bin/next"
          : "pnpm exec next"
      } ${
        // Node closes a keep-alive socket idle for 5s (plus a 1s buffer) while
        // a spec's request client may be sending on it: read ECONNRESET. No
        // socket outlives the request context of a test, so outlast the test
        // timeout instead.
        production ? "start --keepAliveTimeout 300000" : "dev --turbopack"
      } --port ${basePort}`,
      cwd: process.cwd(),
      url: `${baseURL}/api/auth/ok`,
      timeout: 240_000,
      reuseExistingServer: !process.env.CI,
      env: {
        ...process.env,
        MCP_SERVER_URL_OVERRIDES: "",
        NODE_ENV: production ? "production" : "development",
        NODE_OPTIONS: nodeOptions,
        NEXT_PUBLIC_BASE_URL: baseURL,
        NEXT_PUBLIC_MAIL_ENGINE_TEST_INSPECT: "true",
        DATABASE_URL: databaseUrl,
        PREVIEW_DATABASE_URL: databaseUrl,
        AUTH_SECRET: process.env.AUTH_SECRET ?? "secret",
        ...(process.env.PLAYWRIGHT_SCIM_TEST === "true" && {
          ADMINS: playwrightTestEmail,
          SCIM_CREDENTIAL_HASH_SECRET:
            "playwright-only-scim-credential-secret-32-characters",
        }),
        GOOGLE_CLIENT_ID: process.env.GOOGLE_CLIENT_ID ?? "client_id",
        GOOGLE_CLIENT_SECRET:
          process.env.GOOGLE_CLIENT_SECRET ?? "client_secret",
        ...(mailProvider === "microsoft"
          ? {
              MICROSOFT_BASE_URL: emulateBaseUrl,
              MICROSOFT_CLIENT_ID: microsoftClientId,
              MICROSOFT_CLIENT_SECRET: microsoftClientSecret,
              MICROSOFT_WEBHOOK_CLIENT_STATE: microsoftWebhookClientState,
            }
          : {
              GOOGLE_BASE_URL: emulateBaseUrl,
              MICROSOFT_BASE_URL: linkedMicrosoftBaseUrl,
              MICROSOFT_CLIENT_ID: microsoftClientId,
              MICROSOFT_CLIENT_SECRET: microsoftClientSecret,
              MICROSOFT_WEBHOOK_CLIENT_STATE: microsoftWebhookClientState,
            }),
        GOOGLE_PUBSUB_TOPIC_NAME:
          process.env.GOOGLE_PUBSUB_TOPIC_NAME ?? "topic",
        GOOGLE_PUBSUB_VERIFICATION_TOKEN:
          process.env.GOOGLE_PUBSUB_VERIFICATION_TOKEN ?? "playwright-token",
        EMAIL_ENCRYPT_SECRET: process.env.EMAIL_ENCRYPT_SECRET ?? "secret",
        EMAIL_ENCRYPT_SALT: process.env.EMAIL_ENCRYPT_SALT ?? "salt",
        API_KEY_SALT: process.env.API_KEY_SALT ?? "playwright-api-key-salt",
        INTERNAL_API_KEY: internalApiKey,
        // Every model role resolves to the emulator so no spec depends on a
        // live provider.
        DEFAULT_LLMS: `openai-compatible:${llmModelName}`,
        ECONOMY_LLMS: "",
        CHAT_LLMS: "",
        NANO_LLMS: "",
        DRAFT_LLMS: "",
        OPENAI_COMPATIBLE_BASE_URL: `${llmBaseUrl}/v1`,
        OPENAI_API_KEY: "",
        ANTHROPIC_API_KEY: "",
        OPENROUTER_API_KEY: "",
        AI_GATEWAY_API_KEY: "",
        REDIS_HTTP_URL:
          process.env.REDIS_HTTP_URL || process.env.UPSTASH_REDIS_URL || "",
        REDIS_HTTP_TOKEN:
          process.env.REDIS_HTTP_TOKEN || process.env.UPSTASH_REDIS_TOKEN || "",
        QSTASH_TOKEN: "",
        QSTASH_CURRENT_SIGNING_KEY: "",
        QSTASH_NEXT_SIGNING_KEY: "",
        RESEND_API_KEY: "playwright-email-key",
        RESEND_BASE_URL: emailBaseUrl,
        RESEND_AUDIENCE_ID: "playwright-audience",
        RESEND_FROM_EMAIL: "Inbox Zero <signin@example.com>",
        LOOPS_API_SECRET: "",
        DUB_API_KEY: "",
        FB_CONVERSION_API_ACCESS_TOKEN: "",
        FB_PIXEL_ID: "",
        CONVERSION_ANALYTICS_SERVER_URL: "",
        CONVERSION_ANALYTICS_SERVER_SECRET: "",
        POSTHOG_API_SECRET: "",
        NEXT_PUBLIC_POSTHOG_KEY: "",
        NEXT_PUBLIC_POSTHOG_API_HOST: "",
        NEXT_PUBLIC_DUB_REFER_DOMAIN: "",
        NEXT_PUBLIC_IS_RESEND_CONFIGURED: "",
        NEXT_PUBLIC_CONTACTS_ENABLED:
          process.env.NEXT_PUBLIC_CONTACTS_ENABLED ?? "true",
        NEXT_PUBLIC_EMAIL_SEND_ENABLED: "true",
        NEXT_PUBLIC_MEETING_RECORDER_ENABLED: "true",
        NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS: "",
        STRIPE_API_BASE_URL: stripeBaseUrl,
        STRIPE_SECRET_KEY: stripeSecretKey,
        STRIPE_WEBHOOK_SECRET: stripeWebhookSecret,
        PLAYWRIGHT_TEST_EMAIL: playwrightTestEmail,
      },
    },
  ],
});

function writeEmulateSeed({
  baseURL,
  mailProvider,
  playwrightTestEmail,
  runId,
  extraMailboxes,
}) {
  const isMicrosoft = mailProvider === "microsoft";
  const templatePath = path.join(
    process.cwd(),
    isMicrosoft
      ? "emulate.playwright.microsoft.yaml"
      : "emulate.playwright.config.yaml",
  );
  const outputDir = path.join(process.cwd(), ".tmp", "playwright", runId);
  const outputPath = path.join(outputDir, "emulate.playwright.generated.yaml");
  const redirectUri = new URL(
    isMicrosoft ? "/api/auth/callback/microsoft" : "/api/auth/callback/google",
    baseURL,
  ).href;
  const linkingUri = new URL(
    isMicrosoft
      ? "/api/outlook/linking/callback"
      : "/api/google/linking/callback",
    baseURL,
  ).href;
  const meetingStart = new Date(Date.now() + 2 * 60 * 60 * 1000);
  const meetingEnd = new Date(meetingStart.getTime() + 30 * 60 * 1000);
  const profileImage = fs.readFileSync(
    path.join(process.cwd(), "public/splash_screens/icon.png"),
  );

  fs.mkdirSync(outputDir, { recursive: true });

  let seed = fs
    .readFileSync(templatePath, "utf8")
    .replaceAll("__PLAYWRIGHT_TEST_EMAIL__", playwrightTestEmail)
    .replaceAll(
      "__PLAYWRIGHT_TEAM_B_EMAIL__",
      teammateEmail(playwrightTestEmail, "b"),
    )
    .replaceAll(
      "__PLAYWRIGHT_TEAM_C_EMAIL__",
      teammateEmail(playwrightTestEmail, "c"),
    )
    .replaceAll(
      "__PLAYWRIGHT_TEAM_D_EMAIL__",
      teammateEmail(playwrightTestEmail, "d"),
    )
    .replaceAll("__PLAYWRIGHT_TEST_REDIRECT_URI__", redirectUri)
    .replaceAll("__PLAYWRIGHT_TEST_LINKING_URI__", linkingUri)
    .replaceAll("__PLAYWRIGHT_MEETING_START__", meetingStart.toISOString())
    .replaceAll("__PLAYWRIGHT_MEETING_END__", meetingEnd.toISOString())
    .replaceAll(
      "__PLAYWRIGHT_READER_VISUAL_RAW__",
      createReaderVisualMessage({
        attachment: profileImage,
        recipient: playwrightTestEmail,
      }),
    )
    .replaceAll(
      "__PLAYWRIGHT_CALENDAR_INVITE_RAW__",
      createCalendarInviteMessage({
        recipient: playwrightTestEmail,
        start: meetingStart,
        end: meetingEnd,
      }),
    )
    .replaceAll("__PLAYWRIGHT_LONG_LINK__", createOverflowLongLink())
    .replaceAll(
      "__PLAYWRIGHT_DESIGNED_HTML__",
      JSON.stringify(createDesignedThemeHtml()).slice(1, -1),
    )
    .replaceAll(
      "__PLAYWRIGHT_DARK_NEWSLETTER_HTML__",
      JSON.stringify(createDarkModeNewsletterHtml()).slice(1, -1),
    )
    .replaceAll(
      "__PLAYWRIGHT_DARK_FOLLOWUP_HTML__",
      JSON.stringify(createDarkModeFollowupHtml()).slice(1, -1),
    )
    .replaceAll(
      "__PLAYWRIGHT_DARK_AUTHORED_HTML__",
      JSON.stringify(createDarkModeAuthoredHtml()).slice(1, -1),
    )
    .replaceAll(
      "__PLAYWRIGHT_DARK_RECEIPT_HTML__",
      JSON.stringify(createDarkModeReceiptHtml()).slice(1, -1),
    );

  seed = withExtraMailboxes(seed, {
    isMicrosoft,
    primaryEmail: playwrightTestEmail,
    extraMailboxes,
  });

  // Mailbox synchronization only covers recent mail. Preserve the fixture's
  // ordering without letting fixed seed dates age out of that window.
  seed = isMicrosoft
    ? refreshMicrosoftMessageDates(seed)
    : refreshGmailMessageDates(seed);

  fs.writeFileSync(outputPath, seed);

  return outputPath;
}

function writeLinkedMicrosoftSeed({ baseURL, linkedOutlookEmail, runId }) {
  const outputDir = path.join(process.cwd(), ".tmp", "playwright", runId);
  const outputPath = path.join(
    outputDir,
    "emulate.playwright.linked-microsoft.generated.yaml",
  );
  const receivedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  // Just after the Google calendar's meeting, so Today's next meetings come
  // from both calendars. It is on its own calendar because the emulator also
  // seeds earlier meetings on the default ones, which the spec turns off.
  const meetingStart = new Date(Date.now() + 135 * 60 * 1000);
  const meetingEnd = new Date(meetingStart.getTime() + 30 * 60 * 1000);
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(
    outputPath,
    `microsoft:
  users:
    - email: ${linkedOutlookEmail}
      name: Playwright Outlook
  oauth_clients:
    - client_id: emulate-microsoft-client-id
      client_secret: emulate-microsoft-secret
      name: Inbox Zero Smoke
      redirect_uris:
        - ${new URL("/api/auth/callback/microsoft", baseURL).href}
        - ${new URL("/api/outlook/linking/callback", baseURL).href}
  messages:
    - id: msg_playwright_linked_outlook
      conversation_id: thr_playwright_linked_outlook
      user_email: ${linkedOutlookEmail}
      from:
        address: alice@example.com
        name: Alice Example
      to_recipients:
        - address: ${linkedOutlookEmail}
      subject: Linked Outlook Message
      body_content: This conversation lives in the linked Outlook mailbox.
      body_content_type: text
      parent_folder_id: inbox
      is_read: false
      received_date_time: "${receivedAt}"
  calendars:
    - id: ${LINKED_OUTLOOK_CALENDAR_ID}
      user_email: ${linkedOutlookEmail}
      name: Design
  calendar_events:
    - id: evt_playwright_linked_outlook
      user_email: ${linkedOutlookEmail}
      calendar_id: ${LINKED_OUTLOOK_CALENDAR_ID}
      subject: Outlook design review
      start_date_time: "${meetingStart.toISOString()}"
      end_date_time: "${meetingEnd.toISOString()}"
      attendees:
        - address: ${linkedOutlookEmail}
        - address: designer@example.com
          name: Design Partner
`,
  );
  return outputPath;
}

// Keep in sync with teammateEmail in team-comments-test-helpers.ts. The role
// goes at the end of the local part so the publisher's address is never a
// substring of a teammate's, which the OAuth account picker matches on.
/**
 * Gives each extra mailbox its own user, token and copy of the primary
 * mailbox's mail. Copies get their own message ids, and so their own
 * Message-IDs: two accounts share a message only where a spec makes them.
 * Threads keep their ids, which the emulator keeps apart per user.
 */
function withExtraMailboxes(
  seed,
  { isMicrosoft, primaryEmail, extraMailboxes },
) {
  const lines = seed.split("\n");
  for (const block of isMicrosoft
    ? ["categories", "messages"]
    : ["labels", "messages"]) {
    const start = lines.indexOf(`  ${block}:`);
    if (start < 0) throw new Error(`The emulator seed has no ${block}`);
    let end = start + 1;
    while (end < lines.length && !/^ {0,2}\S/.test(lines[end])) end++;
    const items = lines.slice(start + 1, end);
    const copies = extraMailboxes.flatMap((mailbox) =>
      items.flatMap((line) => {
        if (/^\s+message_id: /.test(line)) return [];
        const copy = line.replaceAll(primaryEmail, mailbox.email);
        // Gmail labels are each user's own; Outlook category ids are not.
        if (block === "labels") return [copy];
        return [
          copy.replace(
            /^( {4}- id: )("?)([^"]+)("?)$/,
            `$1$2$3${mailbox.idSuffix}$4`,
          ),
        ];
      }),
    );
    lines.splice(end, 0, ...copies);
  }

  // After the primary user: the emulator answers a token it doesn't know as
  // its first user, which the primary's stored token relies on.
  let usersEnd = lines.indexOf("  users:") + 1;
  while (/^ {4}/.test(lines[usersEnd] ?? "")) usersEnd++;
  lines.splice(
    usersEnd,
    0,
    ...extraMailboxes.flatMap((mailbox, index) => [
      `    - email: ${mailbox.email}`,
      `      name: Playwright Mailbox ${index + 1}`,
    ]),
  );

  const scopes = isMicrosoft
    ? ["openid", "email", "profile", "User.Read", "Mail.ReadWrite"]
    : [
        "openid",
        "email",
        "profile",
        "https://www.googleapis.com/auth/gmail.modify",
      ];
  const tokens = extraMailboxes.flatMap((mailbox) => [
    `  ${mailbox.token}:`,
    `    login: ${mailbox.email}`,
    "    scopes:",
    ...scopes.map((scope) => `      - ${scope}`),
  ]);
  if (lines[0] === "tokens:") lines.splice(1, 0, ...tokens);
  else lines.unshift("tokens:", ...tokens);
  return lines.join("\n");
}

function teammateEmail(publisherEmail, role) {
  const at = publisherEmail.lastIndexOf("@");
  return `${publisherEmail.slice(0, at)}+team-${role}${publisherEmail.slice(at)}`;
}

function refreshGmailMessageDates(seed) {
  const messageDates = [
    ...new Set(
      [...seed.matchAll(/internal_date: "(\d+)"/g)].map((match) =>
        Number(match[1]),
      ),
    ),
  ].sort((left, right) => right - left);
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;
  return seed.replaceAll(/internal_date: "(\d+)"/g, (_, timestamp) => {
    const date =
      yesterday - messageDates.indexOf(Number(timestamp)) * 60 * 60 * 1000;
    return `internal_date: "${date}"`;
  });
}

function refreshMicrosoftMessageDates(seed) {
  const messageDates = [
    ...new Set(
      [...seed.matchAll(/received_date_time: "([^"]+)"/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort((left, right) => Date.parse(right) - Date.parse(left));
  const yesterday = Date.now() - 24 * 60 * 60 * 1000;
  return seed.replaceAll(/received_date_time: "([^"]+)"/g, (_, timestamp) => {
    const date = new Date(
      yesterday - messageDates.indexOf(timestamp) * 60 * 60 * 1000,
    );
    return `received_date_time: "${date.toISOString()}"`;
  });
}

function createReaderVisualMessage({ attachment, recipient }) {
  const boundary = "playwright-reader-visual-boundary";
  const html = [
    '<!doctype html><html lang="en"><head><style>p { margin: 0 0 16px; }</style></head>',
    '<body style="margin: 0; padding: 16px; background: #232326; color: #f4e9da; font-family: Arial, sans-serif">',
    "<div><p>The current reply stays concise and easy to scan.</p>",
    "<p>The attached image should appear as a preview below.</p></div>",
    '<div id="divRplyFwdMsg"><hr><div><b>From:</b> Previous sender</div></div>',
    "<div><p>This earlier quoted message is hidden until expanded.</p></div>",
    "</body></html>",
  ].join("");
  const mime = [
    "From: Morgan Example <morgan@example.com>",
    `To: ${recipient}`,
    "Subject: Re: Reader Visual Message",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    html,
    `--${boundary}`,
    'Content-Type: image/png; name="reader-preview.png"',
    'Content-Disposition: attachment; filename="reader-preview.png"',
    "Content-Transfer-Encoding: base64",
    "",
    attachment.toString("base64"),
    `--${boundary}--`,
    "",
  ].join("\r\n");

  return Buffer.from(mime, "utf8").toString("base64url");
}

function createCalendarInviteMessage({ recipient, start, end }) {
  const boundary = "playwright-calendar-invite-boundary";
  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Inbox Zero//Playwright//EN",
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:playwright-calendar-invite@example.com",
    "SUMMARY:Project planning",
    `DTSTART:${toIcsUtc(start)}`,
    `DTEND:${toIcsUtc(end)}`,
    "ORGANIZER:mailto:organizer@example.com",
    `ATTENDEE;PARTSTAT=ACCEPTED:mailto:${recipient}`,
    "END:VEVENT",
    "END:VCALENDAR",
  ].join("\r\n");
  const mime = [
    "From: Organizer Example <organizer@example.com>",
    `To: ${recipient}`,
    "Subject: Calendar Invitation Message",
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    "",
    "Please join the project planning meeting.",
    `--${boundary}`,
    'Content-Type: text/calendar; method=REQUEST; charset="UTF-8"',
    'Content-Disposition: attachment; filename="invite.ics"',
    "",
    ics,
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return Buffer.from(mime, "utf8").toString("base64url");
}

function toIcsUtc(value) {
  return new Date(value)
    .toISOString()
    .replaceAll("-", "")
    .replaceAll(":", "")
    .replace(/\.\d{3}Z$/, "Z");
}

function createOverflowLongLink() {
  return `https://example.com/account?reference=${"abcdef0123456789".repeat(24)}`;
}

function createDesignedThemeHtml() {
  return `<html><head><style>
          .card { background: #f8f9fa; color: #202124; }
          @media (prefers-color-scheme: dark) {
            .card { background: #202124 !important; color: #e8eaed !important; }
          }
        </style></head><body>
          <div class="card" style="background:#f8f9fa;color:#202124;font-family:Arial,sans-serif;font-size:16px">
            Finish setup
          </div>
        </body></html>`;
}

// A white newsletter of the kind most senders send: gray page, white card,
// a vivid brand banner and button, a pastel callout, an image and a footer.
function createDarkModeNewsletterHtml() {
  const logo = svgDataUri(
    '<svg xmlns="http://www.w3.org/2000/svg" width="140" height="28"><rect width="28" height="28" rx="6" fill="#ff5a1f"/><text x="36" y="20" font-family="Arial" font-size="16" font-weight="700" fill="#111827">Field Notes</text></svg>',
  );
  const photo = svgDataUri(
    '<svg xmlns="http://www.w3.org/2000/svg" width="520" height="180"><defs><linearGradient id="g" x1="0" x2="1"><stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#fde68a"/></linearGradient></defs><rect width="520" height="180" fill="url(#g)"/><circle cx="420" cy="60" r="28" fill="#fff7ed"/><path d="M0 180 L140 90 L260 160 L360 110 L520 180 Z" fill="#166534"/></svg>',
  );
  return `<html><head><style>
    .preheader { display: none; }
    a.button { text-decoration: none; }
  </style></head>
  <body style="margin:0;background:#f2f3f5;font-family:Arial,sans-serif">
    <table width="100%" bgcolor="#f2f3f5" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
      <table width="560" bgcolor="#ffffff" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:8px">
        <tr><td style="padding:20px 24px"><img src="${logo}" width="140" height="28" alt="Field Notes"></td></tr>
        <tr><td style="background:#ff5a1f;color:#ffffff;padding:14px 24px;font-size:15px;font-weight:bold">Issue 42 · The quiet trails edition</td></tr>
        <tr><td style="padding:20px 24px 0"><img src="${photo}" width="512" alt="Mountain trail at dawn" style="display:block;border-radius:6px"></td></tr>
        <tr><td style="padding:20px 24px;color:#333333;font-size:15px;line-height:1.6">
          <h1 style="margin:0 0 12px;color:#111111;font-size:24px">Five trails nobody talks about</h1>
          <p style="margin:0 0 12px">This week we walked the ridgelines that stay empty even in October. <a href="https://example.com/trails" style="color:#1a73e8">Read the full guide</a> or skip to the map.</p>
          <p style="margin:0 0 16px;color:#6b7280;font-size:13px">Photos by our readers. Distances are one way.</p>
          <table cellpadding="0" cellspacing="0" width="100%" style="background:#fff4e5;border-left:4px solid #f59e0b"><tr><td style="padding:12px 16px;color:#8a4b00;font-size:14px">Heads up: the north loop closes for repairs on November 3.</td></tr></table>
          <p style="margin:20px 0"><a class="button" href="https://example.com/map" style="background:#1a73e8;color:#ffffff;padding:10px 18px;border-radius:6px;display:inline-block;font-weight:bold">Open the trail map</a></p>
          <div style="background-image:linear-gradient(135deg,#1e3a8a,#0ea5e9);color:#ffffff;padding:16px;border-radius:6px">Member pick: a sunrise hike with the community, Saturday at 6am.</div>
        </td></tr>
        <tr><td bgcolor="#fafafa" style="padding:16px 24px;border-top:1px solid #e5e7eb;color:#6b7280;font-size:12px">You are receiving this because you subscribed to Field Notes. <a href="https://example.com/unsubscribe" style="color:#6b7280">Unsubscribe</a></td></tr>
      </table>
    </td></tr></table>
  </body></html>`;
}

function createDarkModeFollowupHtml() {
  return `<html><body style="margin:0;background:#ffffff;font-family:Arial,sans-serif">
    <table width="100%" bgcolor="#ffffff" cellpadding="0" cellspacing="0"><tr><td style="padding:24px;color:#222222;font-size:15px">
      <h2 style="margin:0 0 8px;color:#111111">Field Notes: reader mailbag</h2>
      <p style="margin:0">Your questions about the quiet trails, answered.</p>
    </td></tr></table>
  </body></html>`;
}

// Declares its own dark palette, the way Apple and Stripe receipts do.
function createDarkModeAuthoredHtml() {
  return `<html><head>
    <meta name="color-scheme" content="light dark">
    <meta name="supported-color-schemes" content="light dark">
    <style>
      body, .canvas { background: #ffffff; color: #1f2937; }
      .card { background: #f5f3ff; color: #312e81; }
      .accent { color: #6d28d9; }
      @media (prefers-color-scheme: dark) {
        body, .canvas { background: #0f0a1f !important; color: #ede9fe !important; }
        .card { background: #1e1840 !important; color: #ddd6fe !important; }
        .accent { color: #c4b5fd !important; }
      }
    </style></head>
  <body style="margin:0;font-family:Arial,sans-serif">
    <div class="canvas" style="padding:24px">
      <h1 class="accent" style="margin:0 0 12px;font-size:22px">Aurora · Your October recap</h1>
      <div class="card" style="padding:16px;border-radius:8px">You logged 31 clear nights and spotted the aurora 4 times.</div>
      <p style="margin:16px 0 0">Our own dark palette, chosen by the sender.</p>
    </div>
  </body></html>`;
}

// A receipt with a dark-on-transparent logo, line items and a totals table.
function createDarkModeReceiptHtml() {
  const logo = svgDataUri(
    '<svg xmlns="http://www.w3.org/2000/svg" width="172" height="36"><circle cx="18" cy="18" r="16" fill="#3f2a1d"/><text x="42" y="24" font-family="Georgia" font-size="18" fill="#3f2a1d">Lumen Coffee</text></svg>',
  );
  const row = (item, price) =>
    `<tr><td style="padding:8px 0;border-bottom:1px solid #eeeeee">${item}</td><td align="right" style="padding:8px 0;border-bottom:1px solid #eeeeee">${price}</td></tr>`;
  return `<html><body style="margin:0;font-family:Helvetica,Arial,sans-serif;color:#000000">
    <table width="100%" cellpadding="0" cellspacing="0" bgcolor="#ffffff"><tr><td style="padding:24px">
      <img src="${logo}" width="172" height="36" alt="Lumen Coffee">
      <h2 style="margin:16px 0 4px;font-size:20px">Thanks for your order</h2>
      <p style="margin:0 0 16px;color:#555555;font-size:13px">Order #LC-20931 · Pickup at Market Street</p>
      <table width="100%" cellpadding="0" cellspacing="0" style="font-size:14px">
        ${row("Flat white, oat", "$5.25")}
        ${row("Cardamom bun", "$4.00")}
        ${row("Beans: Ethiopia Guji, 250g", "$18.00")}
        <tr><td style="padding:12px 0 0;font-weight:bold">Total</td><td align="right" style="padding:12px 0 0;font-weight:bold">$27.25</td></tr>
      </table>
      <p style="margin:20px 0 0;font-size:13px"><a href="https://example.com/receipt" style="color:#0645ad">View receipt online</a></p>
    </td></tr></table>
  </body></html>`;
}

function svgDataUri(svg) {
  return `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;
}

function getUrlPort(url) {
  const parsed = new URL(url);
  if (parsed.port) return parsed.port;
  return parsed.protocol === "https:" ? "443" : "80";
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Could not allocate a local Playwright port"));
        return;
      }
      server.close(() => {
        if (allocatedPorts.has(address.port)) {
          getAvailablePort().then(resolve, reject);
          return;
        }
        allocatedPorts.add(address.port);
        resolve(address.port);
      });
    });
  });
}
