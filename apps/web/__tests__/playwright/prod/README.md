# Production robot

A synthetic user that walks https://cue-inbox.vercel.app every hour as a
dedicated QA Gmail account, plus a digest of the last hour of Axiom logs and
the last day of Sentry issues. The workflow is
`.github/workflows/prod-health.yml`; each run prints one JSON block between
`=== CUE HEALTH REPORT START ===` and `=== CUE HEALTH REPORT END ===` in the
"Health report" step log, a short summary, and the same report in the job
summary. Screenshots, the Playwright HTML report and, on failure, a trace are
uploaded as the `prod-health-<run>` artifact (kept 7 days).

Unlike `../emulated/`, nothing here is emulated: the robot signs in to
production with an email code it reads from the QA inbox over IMAP.

## What a run checks

| Step | Passes when | Metrics |
| --- | --- | --- |
| sign in with email code | the code arrives over IMAP and lands on Settings | `codeDeliveryMs`, `signInMs` |
| gmail connection | the QA mailbox is connected (a disconnected one is reported, not failed) | `providerRateLimited` |
| inbox shows real mail | a row appears; no "Gmail is limiting" banner, no "Waiting to sync" | `timeToFirstRowMs`, `inboxRows` |
| thread shows reply actions | the seeded class announcement shows Reply, Reply all, Forward | |
| reply to self lands in Sent | a probe sent to itself arrives, the reply shows in Sent | `inboundSyncMs`, `replyToSentMs` |
| Today shows its sections | a lane heading or status line appears | `todayLoadMs`, `todaySections` |
| chat answers about seeded mail | "When is milestone 2 due?" gets a non-error answer | `chatAnswerMs`, `chatMentionsDueDay` |
| Settings / Integrations / Rules | each page renders; Integrations is not "limited rollout" | |
| old mail URL redirects | `/{accountId}/mail` ends on `/mail/u/{n}/inbox` | |
| sign out in one click | Settings' Sign out ends the session | `signOutMs` |

Each step records its duration, console errors and HTTP responses ≥ 400
(paths only, no query strings). Logs and the report never contain subjects,
bodies or addresses.

Mail safety: the robot only ever sends to its own address. The probe goes out
over SMTP from the QA account to itself, the reply is checked to have no other
recipient before Send, and while it is in flight any app write naming another
address is blocked. Seeded mail rewrites every other address to the reserved
`example.com` domain. Probes older than three days are moved to Trash.

A lapsed Gmail connection (see the weekly note below) shows as a
`needs_reconnect` outcome and a "Cue QA test account needs reconnecting"
warning: Gmail-backed steps are skipped instead of each failing. Every other
failure fails the job.

## One-time setup

1. **Create the account.** Make a new Google account just for this, for
   example `cue.qa.test@gmail.com`. Do not reuse a personal one.
2. **Turn on 2-Step Verification** for it (Google Account → Security). App
   passwords require it.
3. **Create an app password** (Google Account → Security → 2-Step Verification
   → App passwords, or https://myaccount.google.com/apppasswords). Name it
   "Cue QA robot" and keep the 16 characters for `CUE_QA_IMAP_APP_PASSWORD`.
   App passwords do not expire, and IMAP is always on for Gmail.
4. **Add it as a test user** of the Google Cloud OAuth app (APIs & Services →
   OAuth consent screen → Audience → Test users).
5. **Sign in to Cue once with Google** as that account at
   https://cue-inbox.vercel.app, finish onboarding and connect Gmail. It
   should be the account's only (first) mailbox. Turn on the AI assistant and
   reply tracking if they are not on by default, so Today and chat have
   something to show.
6. **Turn on email-code sign-in** for it: Settings → "Allow sign-in with a
   one-time email code". This only works from a Google-signed-in session.
   If the row says **"Email delivery unavailable"**, production cannot send
   codes yet: in Vercel set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (a sender
   on a domain verified in your Resend account; the built-in default sender
   belongs to another domain), redeploy, and try again. See "If email codes
   cannot work" below.
7. **Add the GitHub secrets** at Settings → Secrets and variables → Actions →
   New repository secret:

   | Secret | Value |
   | --- | --- |
   | `CUE_QA_EMAIL` | the QA account's address |
   | `CUE_QA_IMAP_APP_PASSWORD` | the app password from step 3 |
   | `AXIOM_QUERY_TOKEN` | an Axiom API token with **Query** permission on the dataset |
   | `AXIOM_DATASET` | the dataset production logs go to (Vercel's `NEXT_PUBLIC_AXIOM_DATASET`) |
   | `SENTRY_AUTH_TOKEN` | a Sentry auth token with `project:read`, `event:read`, `org:read` |
   | `SENTRY_ORGANIZATION` | the Sentry organization slug |
   | `SENTRY_PROJECT` | the Sentry project slug |

   Any group left out is skipped with a `NOT CONFIGURED` line. For EU-hosted
   Axiom or Sentry, also set `AXIOM_URL` / `SENTRY_URL` in the workflow's `env`.
8. **Seed the inbox.** Run the workflow
   manually (Actions → Production Health → Run workflow) with **seed**
   checked. Seeding is idempotent; rerun it whenever the inbox was cleared.
9. **Sentry:** create a Next.js project in Sentry, then add its DSN as
   `NEXT_PUBLIC_SENTRY_DSN` in Vercel (Production) and redeploy, so production
   errors reach it.
10. **Axiom:** in Axiom, Settings → API tokens → New token, with query access
    to the production dataset. A personal token also needs an org ID header,
    so use an API token.

## Weekly: reconnect the test account

The OAuth app is in Testing mode, so Google expires Cue's Gmail refresh token
for the QA account every 7 days. When the job shows the
**"Cue QA test account needs reconnecting"** warning (or the report's
`robot.outcome` is `needs_reconnect`), sign in to Cue as the QA account **with
Google** in a normal browser and reconnect Gmail (the mail view's Reconnect
prompt, or Accounts). An email-code session cannot do this: email-code
sessions are not allowed to change authentication. Doing it every Monday
avoids the gap.

## If email codes cannot work

Email-code sign-in needs production to send mail through Resend
(`deliverTransactionalEmail` returns nothing without `RESEND_API_KEY`; the
send endpoint still answers "success" so it does not reveal accounts, so the
robot reports "No sign-in code email arrived"). Configuring Resend is the fix.

If that is not possible, the next most robust option is a stored session: sign
in with Google once in a private window, copy the `__Secure-better-auth.session_token`
cookie into a GitHub secret, and have the robot load it instead of signing in.
Sessions last 30 days and extend daily while used, so an hourly robot keeps one
alive, but only if it never signs out: the sign-out step would have to verify
the button on a second, throwaway session instead. It is weaker because a
leaked cookie is a full session until revoked, and a Google re-consent or
manual sign-out breaks it silently. Google sign-in itself is not an option for
a robot: Google blocks automated browsers.

## Running locally

```sh
# Report only (each source not configured prints NOT CONFIGURED)
pnpm -F inbox-zero-ai exec tsx scripts/qa/run-health-report.ts .tmp/qa-robot/results.json

# Seed and run against production as the QA account
export CUE_QA_EMAIL=... CUE_QA_IMAP_APP_PASSWORD=...
pnpm -F inbox-zero-ai exec tsx scripts/qa/seed-test-inbox.ts
pnpm -F inbox-zero-ai exec playwright test -c __tests__/playwright/prod/playwright.prod.config.ts
```

Set `CUE_QA_BASE_URL` to aim the robot at another deployment whose QA account
can receive codes in the same Gmail inbox. Without `CUE_QA_EMAIL` and
`CUE_QA_IMAP_APP_PASSWORD` the spec skips without launching a browser.

The repository is public, so anyone signed in to GitHub can read the job logs,
summary and artifacts. Screenshots show the seeded inbox and the QA address.
The robot ends its session server-side when it finishes, so a trace's cookies
cannot be replayed, and the one-time code it typed is already spent.
