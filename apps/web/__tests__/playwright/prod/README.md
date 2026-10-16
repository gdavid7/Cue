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

With `CUE_QA_OUTLOOK_EMAIL` set (see "Outlook QA mailbox" below), the robot
also runs these steps on the Outlook mailbox, named `Outlook: …` in the
report. Without it they are left out and the report says
`Outlook: NOT CONFIGURED`.

| Step | Passes when | Metrics |
| --- | --- | --- |
| Outlook: mailbox is connected | the Outlook QA mailbox is linked to the QA user and not disconnected; otherwise the other Outlook steps skip | |
| Outlook: inbox shows mail | a row appears and nothing asks to reconnect | `timeToFirstRowMs` |
| Outlook: probe arrives and the reply reaches Gmail | a probe sent over SMTP from the Gmail QA account shows in the Outlook inbox; a reply sent from Cue reaches the Gmail QA inbox (checked over IMAP) | `inboundSyncMs`, `replyDeliveredMs` |
| Outlook: Today shows its sections | as for Gmail | `todayLoadMs` |
| Outlook: chat answers | a question on the Outlook account gets a non-error answer | `chatAnswerMs` |

Each step records its duration, console errors and HTTP responses ≥ 400
(paths only, no query strings). Logs and the report never contain subjects,
bodies or addresses.

Mail safety: the robot only ever sends to its own address. The probe goes out
over SMTP from the QA account to itself, the reply is checked to have no other
recipient before Send, and while it is in flight any app write naming another
address is blocked. Seeded mail rewrites every other address to the reserved
`example.com` domain. Probes older than three days are moved to Trash.

The Outlook steps only ever mail between the two QA addresses: the probe goes
from the Gmail QA account to the configured Outlook address only, the reply
is checked to be addressed to the Gmail QA account alone, and the recipient
guard allows just those two. The Outlook thread is moved to Deleted Items once
checked; Gmail's copies are pruned with the other reply probes.

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

### Outlook QA mailbox (optional)

1. **Create a free Outlook.com account** just for this, for example
   `cue.qa.outlook@outlook.com`. No app password or IMAP is needed: the robot
   reaches it only through Cue.
2. **Link it to the QA user:** sign in to Cue as the QA account, open
   Accounts → **Add Microsoft**, and connect the Outlook account. Gmail stays
   the first mailbox.
3. **Add the GitHub secret** `CUE_QA_OUTLOOK_EMAIL` with its address. Both
   robots pick it up on their next run; remove it to turn the Outlook steps
   off again.

Microsoft refresh tokens slide for 90 days while used, so the robots keep the
link alive without a weekly reconnect. If Cue marks it disconnected, the
`Outlook: mailbox is connected` step fails and says so; reconnect it from
Accounts.

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

## Journeys robot

`.github/workflows/prod-journeys.yml` runs `journeys/journeys.journey.ts` every
three hours (at :41) and on demand. Where the health robot checks that pages
work, the journeys robot times what people do all day, checks what it can know
for certain, and judges each journey **PASS**, **SLOW** (over its target) or
**FAIL** (an error, a wrong answer, or over its limit):

| Journey | What it does | Metrics (budget target / limit, ms) |
| --- | --- | --- |
| `inbox-load` | opens the inbox in a fresh document | `firstRowMs` 5000/30000, `clsX1000` 100/250 |
| `new-mail` | delivers mail while the inbox is open (IMAP APPEND from an example.com sender, and SMTP to itself) and times each until its row shows, without reloading; then delivers while the app is closed and times opening it | `newMailWhileOpenMs:append` and `:smtp` 10000/60000, `newMailOnOpenMs` 3000/15000; `pushEventMs` (until the mail stream reported the change) and `mailStreamConnected` for diagnosis |
| `chat` | asks four questions, each in a new chat, whose answers only mail planted for this run holds (a job offer, a meeting, an invoice, and one across them), and grades each answer by its facts | per question `chatFirstTokenMs` 8000/45000, `chatTotalMs` 40000/150000, `chatToolCalls`; fails on a missing fact, a tool error or a failed request |
| `triage` | opens planted mail, archives it and undoes the archive | `openEmailMs` 1500/10000, `archiveMs` 1000/5000, `undoMs` 1500/8000 |
| `search` | searches for a word only the planted invoice has | `searchMs` 3000/15000 |
| `compose-send` | composes a message to itself and follows it back into the Inbox | `composeOpenMs` 1000/5000, `sendToInboxMs` 45000/120000 (includes the 30 s undo window) |
| `outlook` | only with `CUE_QA_OUTLOOK_EMAIL`: opens the Outlook QA mailbox, sends it a probe from the Gmail QA account over SMTP and times its row, then replies from Cue and times the reply into the Gmail QA inbox (IMAP) | `firstRowMs:outlook`, `newMailWhileOpenMs:outlook`, `replyDeliveredMs` 60000/180000 |

Every journey also fails on an uncaught page error, a hydration error or a 5xx
from Cue, and reports other console errors and 4xx responses as warnings. A
failed journey is retried once in the same session; one that passes on retry
is reported as **flaky**. The run stops starting journeys after 12.5 minutes.

Run it from Actions → Production Journeys → Run workflow, or through the API:

```sh
gh workflow run prod-journeys.yml -f journeys=new-mail,chat \
  -f budgets='{"newMailWhileOpenMs":{"target":5000}}'
```

`journeys` is a comma list or `all`; `budgets` overrides targets or limits.
The "Journeys report" step prints the human report between
`=== CUE JOURNEYS REPORT START ===` and `=== CUE JOURNEYS REPORT END ===` and
the full metrics JSON between `=== CUE JOURNEYS METRICS START ===` and
`=== CUE JOURNEYS METRICS END ===`; with the Axiom secrets set it also counts
the server errors and warnings logged during the run. The
`prod-journeys-metrics-<run>` artifact holds both JSON files; screenshots,
traces, video and the chat's answers (`chat-answers-attempt-<n>.json` in the
Playwright report) are uploaded only when the run is not PASS.

Mail: every message the robot creates has `cqj <run tag>` in its subject and
comes from `example.com` or the QA account itself. It is moved to Trash at the
end of the run, and anything an earlier run left behind is moved at the start.
A run creates about eight messages. The workflow shares the health robot's
concurrency group, so the two never request sign-in codes at the same time.

Code sign-ins are capped at 20 per address per day, and every robot run uses
one: the hourly health robot alone uses 24.

```sh
# Against production (or CUE_QA_BASE_URL) as the QA account
CUE_JOURNEYS=new-mail pnpm -F inbox-zero-ai exec playwright test -c __tests__/playwright/prod/journeys/playwright.journeys.config.ts
pnpm -F inbox-zero-ai exec tsx scripts/qa/run-journeys-report.ts .tmp/journeys/results.json

# Against the local emulated stack (Gmail and LLM emulators), to check the
# journeys' logic; its timings say nothing about production
pnpm -F inbox-zero-ai exec playwright test -c __tests__/playwright/prod/journeys/playwright.emulated.config.mjs
```
