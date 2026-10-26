// The one environment Groundtruth's copy of Cue runs with. Build, start and reset all use it, so the build's
// frozen NEXT_PUBLIC_* flags, the CSP origins and the running server always agree.
//
// Every command starts from an EMPTY environment plus this list. The agent's shell carries real production
// tokens (Axiom, Vercel, GitHub, AWS, ...) that Cue would otherwise pick up, and this copy must never log to,
// call or bill a real service. Only the fake mailboxes, fake AI, fake Stripe and fake email server run.

export const PORTS = {
  app: 3100, // not 3000, so it never collides with a dev server
  appServer: 3101, // Next.js itself, behind the front proxy on the app port (proxy.mjs)
  google: 4100, // Gmail emulator; same as CI
  microsoft: 4101, // Outlook emulator origin; CI freezes it into the build's CSP
  email: 4102, // stand-in for Resend
  stripe: 4103,
  postgres: 5442, // its own database, away from the dev database on 5432
  redisHttp: 8089, // away from the dev Redis HTTP proxy on 8079
};

const appUrl = `http://localhost:${PORTS.app}`;

export const APP_ENV = {
  NODE_OPTIONS: "--max_old_space_size=6144",
  NEXT_PUBLIC_BASE_URL: appUrl,
  DATABASE_URL: `postgresql://postgres:postgres@localhost:${PORTS.postgres}/postgres`,
  AUTH_SECRET: "groundtruth-only-secret",
  GOOGLE_CLIENT_ID: "client_id",
  GOOGLE_CLIENT_SECRET: "client_secret",
  GOOGLE_BASE_URL: `http://localhost:${PORTS.google}`,
  MICROSOFT_BASE_URL: `http://localhost:${PORTS.microsoft}`,
  GOOGLE_PUBSUB_TOPIC_NAME: "topic",
  EMAIL_ENCRYPT_SECRET: "groundtruth-only-secret",
  EMAIL_ENCRYPT_SALT: "groundtruth-only-salt",
  INTERNAL_API_KEY: "groundtruth-only-secret",
  DEFAULT_LLMS: "openai-compatible:emulated",
  REDIS_HTTP_URL: `http://localhost:${PORTS.redisHttp}`,
  REDIS_HTTP_TOKEN: "groundtruth-token",
  // Read by apps/web/playwright.config.mjs, whose webServer list stack.mjs runs (the same emulators CI uses).
  PLAYWRIGHT_PRODUCTION: "1",
  PLAYWRIGHT_RUN_ID: "groundtruth",
  PLAYWRIGHT_TEST_EMAIL: "groundtruth-test@gmail.com",
  PLAYWRIGHT_EMAIL_BASE_URL: `http://127.0.0.1:${PORTS.email}`,
  PLAYWRIGHT_STRIPE_BASE_URL: `http://127.0.0.1:${PORTS.stripe}`,
  // Frozen into the build: match the enabled production UI, as CI does.
  NEXT_PUBLIC_EMAIL_SEND_ENABLED: "true",
  NEXT_PUBLIC_MEETING_RECORDER_ENABLED: "true",
  NEXT_PUBLIC_CONTACTS_ENABLED: "true",
  NEXT_PUBLIC_MAIL_ENGINE_TEST_INSPECT: "true",
  NEXT_PUBLIC_INTEGRATIONS_ENABLED: "true",
  NEXT_PUBLIC_INTEGRATION_ACTION_ENABLED: "true",
  NEXT_PUBLIC_EXTERNAL_API_ENABLED: "true",
  NEXT_PUBLIC_STRIPE_BUSINESS_MONTHLY_PRICE_ID: "price_playwright_starter_monthly",
  NEXT_PUBLIC_STRIPE_BUSINESS_ANNUALLY_PRICE_ID: "price_playwright_starter_annually",
  NEXT_PUBLIC_STRIPE_PLUS_MONTHLY_PRICE_ID: "price_playwright_plus_monthly",
  NEXT_PUBLIC_STRIPE_PLUS_ANNUALLY_PRICE_ID: "price_playwright_plus_annually",
  NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_MONTHLY_PRICE_ID: "price_playwright_professional_monthly",
  NEXT_PUBLIC_STRIPE_BUSINESS_PLUS_ANNUALLY_PRICE_ID: "price_playwright_professional_annually",
};

// Machine plumbing only: no tokens. Network settings are kept only for install and build (packages, fonts).
const BASE_KEYS = ["PATH", "HOME", "SHELL", "TERM", "LANG", "TMPDIR", "USER", "PLAYWRIGHT_BROWSERS_PATH", "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE"];
const NETWORK_KEYS = ["HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy", "npm_config_https_proxy", "npm_config_noproxy", "COREPACK_ENABLE_AUTO_PIN"];

export function cleanEnv({ network = false } = {}) {
  const env = {};
  for (const key of [...BASE_KEYS, ...(network ? NETWORK_KEYS : [])]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...APP_ENV, NODE_ENV: "production" };
}
