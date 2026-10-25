# Deploy Cue on Vercel Hobby (free, for you and a few friends)

This guide puts Cue on free tiers only: Vercel Hobby, Neon Postgres, Upstash Redis, a Google Cloud project in testing mode, and a free AI key. It assumes you have never deployed anything before. Plan on about an hour.

What you end up with:

- One Vercel project that builds `apps/web` only. The unsubscribe worker, the desktop app, and the prototypes are not deployed.
- Sign-in limited to the email addresses you list.
- Your API keys pay for (or, on free tiers, rate-limit) everyone's AI use, so the allowlist matters.

Hobby is for personal, non-commercial use. Don't charge your friends.

---

## 0. Before you start

Create free accounts at:

- [vercel.com](https://vercel.com) (sign up with GitHub)
- [console.cloud.google.com](https://console.cloud.google.com)
- [aistudio.google.com](https://aistudio.google.com) (for the Gemini key)
- Optional: [exa.ai](https://exa.ai) (web search), [composio.dev](https://composio.dev) (connectors such as Slack and Drive)

You need the repo on GitHub (your fork of Cue).

**Make the crons daily before your first deploy.** `apps/web/vercel.json` runs `/api/cron/scheduled-actions` and `/api/cron/automation-jobs` more often than once a day, which needs Vercel Pro. Hobby rejects a deployment with any cron more frequent than daily, so in your fork set those two `schedule` values to `"0 0 * * *"` and `"0 14 * * *"`, and commit. Step 7 explains the free pinger that keeps send-later and snooze on time.

Open a terminal and generate the secrets now. Paste each one into a note, because you need them in step 3:

```bash
openssl rand -hex 32   # AUTH_SECRET
openssl rand -hex 32   # INTERNAL_API_KEY
openssl rand -hex 32   # EMAIL_ENCRYPT_SECRET
openssl rand -hex 16   # EMAIL_ENCRYPT_SALT
openssl rand -hex 32   # CRON_SECRET
openssl rand -hex 32   # GOOGLE_PUBSUB_VERIFICATION_TOKEN
openssl rand -hex 32   # MICROSOFT_WEBHOOK_CLIENT_STATE (only if you add Microsoft)
```

`EMAIL_ENCRYPT_SECRET` and `EMAIL_ENCRYPT_SALT` encrypt stored OAuth tokens. Never change them after the first sign-in, or every account has to reconnect.

---

## 1. Import the project into Vercel

1. In Vercel, click **Add New… → Project** and pick your Cue repository.
2. **Root Directory**: click **Edit** and choose `apps/web`. This is the only setting that matters here.
3. **Framework Preset**: Next.js (auto-detected).
4. Leave **Build Command**, **Install Command** and **Output Directory** on their defaults. `apps/web/vercel.json` overrides them:
   - install: `pnpm install` for the whole workspace except the desktop app
   - build: `turbo run build` for `apps/web`, which runs `prisma migrate deploy` and then `next build`
5. Don't add environment variables yet. Click **Deploy**. **The first build will fail** because there is no database yet. That's expected.
6. Note the domain Vercel gives you, for example `https://cue-yourname.vercel.app`. This is your `NEXT_PUBLIC_BASE_URL`. If you want a nicer name, rename it under **Settings → Domains** now, before you set up Google, because the OAuth redirect URIs depend on it.

Then check these settings:

- **Settings → Functions → Fluid Compute**: on (the default). Hobby allows functions to run for up to 300 s only with fluid compute, and every route in the repo is capped at 300 s.
- **Settings → Functions → Function Region**: pick the region nearest your Neon database (for example `iad1` / Washington, D.C. if Neon is in `us-east-1`).
- **Settings → Git → Ignored Build Step**: leave as is. `vercel.json` already skips preview builds for branches other than `main`, which saves Hobby build minutes. To build a branch anyway, set `FORCE_VERCEL_PREVIEW_BUILD=true`.

---

## 2. Add Neon (Postgres) and Upstash (Redis) from Vercel Storage

### Neon

1. In your project, go to **Storage → Create Database → Neon** (Serverless Postgres) → **Continue**.
2. Pick the **Free** plan, a region (the same one as your function region), and a name.
3. Connect it to the project for **Production** and **Preview**. Leave the env var prefix empty.

It sets `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED` (direct), plus `PG*` and `POSTGRES_*` variables that Cue ignores. The app uses `DATABASE_URL`. `prisma migrate deploy` uses `DATABASE_URL_UNPOOLED` when it's present, which is what Neon recommends for migrations.

### Upstash

1. **Storage → Create Database → Upstash** (Upstash for Redis) → **Continue**.
2. **Free** plan, the same region, a name. Connect it to the project. Leave the prefix empty.

It sets `KV_REST_API_URL`, `KV_REST_API_TOKEN` and `KV_URL`, and sometimes `REDIS_URL`. Cue reads them as follows:

| Cue setting | Comes from | Used for |
|---|---|---|
| `REDIS_HTTP_URL` / `REDIS_HTTP_TOKEN` | `KV_REST_API_URL` / `KV_REST_API_TOKEN` (automatic fallback) | caches, rate limits, AI usage tracking |
| `REDIS_URL` | `REDIS_URL`, or `KV_URL` when that is unset | live inbox updates (server-sent events), resuming chat streams |

You don't need to copy anything by hand.

---

## 3. Environment variables

Go to **Settings → Environment Variables**. Add each variable below for **Production**, and also for **Preview** if you plan to use previews.

Variables that start with `NEXT_PUBLIC_` are baked in at build time. After you change one, redeploy.

### Required

| Variable | Value | Where it comes from |
|---|---|---|
| `NEXT_PUBLIC_BASE_URL` | `https://cue-yourname.vercel.app` (no trailing slash) | step 1 |
| `AUTH_SECRET` | 64 hex characters | `openssl rand -hex 32` |
| `INTERNAL_API_KEY` | 64 hex characters | `openssl rand -hex 32` |
| `EMAIL_ENCRYPT_SECRET` | 64 hex characters | `openssl rand -hex 32` |
| `EMAIL_ENCRYPT_SALT` | 32 hex characters | `openssl rand -hex 16` |
| `CRON_SECRET` | 64 hex characters | `openssl rand -hex 32`. Vercel Cron sends it automatically. If it's missing, every cron job returns 401. |
| `GOOGLE_CLIENT_ID` | `…apps.googleusercontent.com` | step 4 |
| `GOOGLE_CLIENT_SECRET` | `GOCSPX-…` | step 4 |
| `GOOGLE_PUBSUB_TOPIC_NAME` | `projects/<project-id>/topics/cue-gmail` | step 5. The build fails without it. If you skip push notifications, use any placeholder like `projects/none/topics/none`. |
| `GOOGLE_PUBSUB_VERIFICATION_TOKEN` | 64 hex characters | `openssl rand -hex 32`, step 5. Leave it unset only if you skip Pub/Sub. |
| `AUTH_ALLOWED_EMAILS` | `you@gmail.com,friend1@gmail.com,friend2@outlook.com` | Only these addresses can create an account. Comma-separated, case-insensitive. |
| `NEXT_PUBLIC_BRAND_NAME` | `Cue` | The app name shown on the sign-in page, page titles and emails. Without it, the app shows "Inbox Zero". |
| `NEXT_PUBLIC_BYPASS_PREMIUM_CHECKS` | `true` | Turns off Stripe and Lemon Squeezy billing, paywalls, and upgrade prompts. Everyone gets every feature. |
| `DEFAULT_LLMS` | see [AI provider](#ai-provider-free) | |
| `GOOGLE_API_KEY` | `AIza…` | Gemini key from AI Studio |

`DATABASE_URL` and the Redis variables come from step 2.

### Recommended

| Variable | Value | Why |
|---|---|---|
| `ECONOMY_LLMS`, `CHAT_LLMS`, `NANO_LLMS`, `DRAFT_LLMS` | see below | Puts cheap, high-volume work on the model with the largest free allowance. |
| `AI_NANO_WEEKLY_SPEND_LIMIT_USD` | `1` | Soft per-user cap. Once someone's estimated weekly spend passes this amount, their calls move to `NANO_LLMS`. Spend is estimated at paid-tier prices even when you're on the free tier, so `1` corresponds to a fair amount of use. This is a downgrade, not a block: Cue has no hard per-user AI cap. |
| `NEXT_PUBLIC_AI_MODEL_SETTINGS_DISABLED` | `true` | Optional. Hides the per-user model and API-key settings so friends can't change models. Leave it unset if you'd like friends to be able to use their own keys. |

### Optional

| Variable | What it enables | Where to get it |
|---|---|---|
| `EXA_API_KEY` | Web search for sender research, meeting briefs, assistant chat, and reading links | [dashboard.exa.ai](https://dashboard.exa.ai) → API Keys (free credits) |
| `COMPOSIO_API_KEY` | Connectors (Slack, Drive, Teams, …) | [platform.composio.dev](https://platform.composio.dev) → Settings → API Keys (free tier) |
| `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_WEBHOOK_CLIENT_STATE` | Outlook / Microsoft 365 sign-in | step 6. If you set the client ID, you must also set the client state, or the build fails. |
| `RESEND_API_KEY` | Transactional emails (digests, "reconnect your account" notices). Without it, these emails are skipped with a log line. | [resend.com](https://resend.com) (free tier) |

Leave everything else unset. Stripe, Lemon Squeezy, Recall (meeting recorder), Tinybird, Loops, PostHog, Sentry, Axiom, and QStash are all optional and do nothing without their keys.

### AI provider (free)

Cue's AI layer supports `anthropic`, `openai`, `google` (Gemini API), `vertex`, `azure`, `bedrock`, `openrouter`, `groq`, `cerebras`, `aigateway`, `ollama`, and `openai-compatible`. The Gemini API is the one with a usable free tier and strong models.

1. Go to [aistudio.google.com](https://aistudio.google.com) → **Get API key** → **Create API key**. You don't need a billing account.
2. Set:

```
GOOGLE_API_KEY=AIza...
DEFAULT_LLMS=google:gemini-3.8-flash,google:gemini-3.1-flash-lite
DRAFT_LLMS=google:gemini-3.8-flash,google:gemini-3.1-flash-lite
CHAT_LLMS=google:gemini-3.8-flash,google:gemini-3.1-flash-lite
ECONOMY_LLMS=google:gemini-3.1-flash-lite,google:gemini-3.8-flash
NANO_LLMS=google:gemini-3.1-flash-lite
```

The first model in each list is the primary. The rest are fallbacks, tried when a call fails (including after repeated 429 rate-limit errors). Free-tier limits are counted per model, so listing both models roughly doubles your headroom.

Things to know about the Gemini free tier:

- **Google may use free-tier prompts and responses to improve its products.** Those prompts contain your friends' emails. Tell them. To avoid it, enable billing on the AI Studio project (the paid tier excludes your data) and set a budget alert.
- Limits are per Google Cloud project, per model, and per minute and per day. The daily limit resets at midnight Pacific. AI Studio → **Usage** shows your live limits. When you hit them, AI features fail with rate-limit errors until the window resets. The mail client itself keeps working.

---

## 4. Google Cloud: OAuth for Gmail

1. **Create a project**: [console.cloud.google.com](https://console.cloud.google.com) → project picker → **New project** → name it `cue` → **Create**. Select it.
2. **Enable the APIs** (APIs & Services → Library → search each one → **Enable**):
   - **Gmail API** (required)
   - **Google Calendar API** (calendar features)
   - **Google People API** (only if you set `NEXT_PUBLIC_CONTACTS_ENABLED=true`)
   - **Google Drive API** (only if you'll use Drive filing)
   - **Cloud Pub/Sub API** (step 5)
3. **Consent screen**: open [Google Auth Platform](https://console.cloud.google.com/auth/overview) → **Get started**.
   - App name `Cue`, your support email → **Audience: External** → your contact email → agree → **Create**.
   - Leave **Publishing status** on **Testing**.
4. **Test users**: **Audience → Test users → Add users**. Add yourself and every friend: the same addresses as in `AUTH_ALLOWED_EMAILS`. You can add up to 100. Google blocks anyone else at the consent screen, so this works as a second allowlist.
5. **Scopes**: **Data Access → Add or remove scopes → Manually add scopes**. Paste the following, then click **Update** and **Save**:

   Requested at sign-in now:
   ```
   https://www.googleapis.com/auth/userinfo.profile
   https://www.googleapis.com/auth/userinfo.email
   https://www.googleapis.com/auth/gmail.modify
   https://www.googleapis.com/auth/gmail.settings.basic
   ```
   Calendar. Today it is requested when a user connects their calendar. A separate change moves it into sign-in, so declare it now:
   ```
   https://www.googleapis.com/auth/calendar.readonly
   https://www.googleapis.com/auth/calendar.events
   https://www.googleapis.com/auth/calendar.freebusy
   ```
   Optional:
   ```
   https://www.googleapis.com/auth/contacts                  # only with NEXT_PUBLIC_CONTACTS_ENABLED=true
   https://www.googleapis.com/auth/drive.file                # Drive filing (standard access)
   https://www.googleapis.com/auth/drive                     # Drive filing (full access)
   ```
6. **OAuth client**: **Clients → Create client → Web application**, named `Cue web`.
   - **Authorized JavaScript origins**: `https://cue-yourname.vercel.app`
   - **Authorized redirect URIs** (all four):
     ```
     https://cue-yourname.vercel.app/api/auth/callback/google
     https://cue-yourname.vercel.app/api/google/linking/callback
     https://cue-yourname.vercel.app/api/google/calendar/callback
     https://cue-yourname.vercel.app/api/google/drive/callback
     ```
   - Click **Create**. Copy the **Client ID** into `GOOGLE_CLIENT_ID` and the **Client secret** into `GOOGLE_CLIENT_SECRET`.

**Testing mode limits.** Google expires refresh tokens after **7 days** for apps in Testing that use Gmail scopes. Each person will be asked to sign in again about once a week. The only way around this is to set Publishing status to **In production**. Without Google's verification, users see an "unverified app" warning, and sensitive or restricted scopes are capped at 100 users. For a handful of friends, weekly re-sign-in is the low-effort choice.

---

## 5. Gmail push notifications (Pub/Sub)

**What it does.** Gmail tells Cue about new mail the moment it arrives. Cue uses this to:

- run your AI rules and auto-drafts on incoming mail
- update open inboxes live
- track replies

**Is it required?** No. There is no polling fallback. Without Pub/Sub, the inbox still loads fresh from Gmail whenever you open or refocus it, and everything you trigger by hand (chat, drafting, search, bulk tools) still works. Automation on incoming mail never runs. That also means no background AI usage, so skipping Pub/Sub is a valid "save my quota" mode.

**Cost.** At this volume, Pub/Sub is within the Google Cloud free tier (10 GiB of messages per month). Google may still ask you to link a billing account before it lets you enable the Pub/Sub API. Linking one doesn't charge you while you stay in the free tier.

**Setup** (in the same Google Cloud project):

1. **Pub/Sub → Topics → Create topic**. Set the ID to `cue-gmail` and untick "Add a default subscription". Click **Create**.
2. Open the topic → **Permissions** (info panel) → **Add principal**:
   - Principal: `gmail-api-push@system.gserviceaccount.com`
   - Role: **Pub/Sub Publisher**
   - **Save**
3. Topic → **Subscriptions → Create subscription**:
   - ID: `cue-gmail-push`
   - Delivery type: **Push**
   - Endpoint: `https://cue-yourname.vercel.app/api/google/webhook?token=<GOOGLE_PUBSUB_VERIFICATION_TOKEN>`
   - Leave the rest at the defaults → **Create**
4. Set `GOOGLE_PUBSUB_TOPIC_NAME=projects/<your-project-id>/topics/cue-gmail` (the project ID is on the dashboard, not the project name).

Cue registers each mailbox with Gmail when the account connects, and re-registers it from the daily `/api/watch/all` cron. Gmail registrations last 7 days, so a daily refresh is plenty.

**Skip it:** set `GOOGLE_PUBSUB_TOPIC_NAME=projects/none/topics/none` and leave `GOOGLE_PUBSUB_VERIFICATION_TOKEN` unset. Registration then fails quietly and logs an error each day.

---

## 6. Microsoft / Outlook (optional)

1. [entra.microsoft.com](https://entra.microsoft.com) → **App registrations → New registration**.
   - Name: `Cue`.
   - Supported account types: **Accounts in any organizational directory and personal Microsoft accounts**.
   - Redirect URI: platform **Web**, `https://cue-yourname.vercel.app/api/auth/callback/microsoft` → **Register**.
2. **Authentication → Add URI** for:
   ```
   https://cue-yourname.vercel.app/api/outlook/linking/callback
   https://cue-yourname.vercel.app/api/outlook/calendar/callback
   https://cue-yourname.vercel.app/api/outlook/drive/callback
   ```
3. **Certificates & secrets → New client secret**. Copy the **Value** (not the ID) into `MICROSOFT_CLIENT_SECRET`.
4. **Overview**: copy the Application (client) ID into `MICROSOFT_CLIENT_ID`. Leave `MICROSOFT_TENANT_ID` unset (`common`).
5. **API permissions → Microsoft Graph → Delegated** permissions:
   - for sign-in and mail: `openid`, `profile`, `email`, `User.Read`, `offline_access`, `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`
   - for calendar: `Calendars.Read`, `Calendars.ReadWrite`
6. Set `MICROSOFT_WEBHOOK_CLIENT_STATE` (from step 0).

Outlook doesn't need Pub/Sub. Cue creates Microsoft Graph subscriptions pointing at `/api/outlook/webhook`, and the daily watch cron renews them.

`AUTH_ALLOWED_EMAILS` is what limits Microsoft sign-ins. Microsoft has no test-user list.

---

## 7. Deploy

1. **Deployments** → newest deployment → **⋯ → Redeploy**. Untick "Use existing build cache" the first time.
2. The build log should show `prisma migrate deploy` applying migrations, then `next build`, then `serwist build`. The build runs on Hobby's machine (2 vCPU, 8 GB). The app's build script caps the Node heap at 6 GB to fit.
3. Open `https://cue-yourname.vercel.app`.

### What runs on a schedule (Hobby allows once a day per job)

The table shows the Hobby schedules you set in step 0.

| Cron | When (UTC, ±59 min) | What it does |
|---|---|---|
| `/api/cron/scheduled-actions` | daily 00:xx | Sends scheduled "send later" emails, un-snoozes threads, and runs delayed rule actions. See the note below. |
| `/api/watch/all` | daily 06:xx | Renews Gmail and Outlook push registrations and flags lapsed ones |
| `/api/follow-up-reminders` | daily 13:xx | Follow-up reminders. Only does work with `NEXT_PUBLIC_FOLLOW_UP_REMINDERS_ENABLED=true`. |
| `/api/cron/automation-jobs` | daily 14:xx | Scheduled assistant check-ins over Slack or Telegram. Only does work when one is connected. |
| `/api/cron/reasoning-retention`, `mobile-push-retention`, `email-send-operation-retention`, `draft-cleanup` | daily 03:00–04:xx | Database and draft cleanup |

These upstream crons were removed for Hobby:

- **Resend digest** (every 5 minutes): needs `RESEND_API_KEY` and `NEXT_PUBLIC_DIGEST_ENABLED`
- **Inbox-health** and **weekly summary** emails: need Resend
- **Meeting briefs** (every 15 minutes): need sub-hour timing and spend AI on every meeting
- **Meeting-recorder scheduling** (every 5 minutes): Recall.ai is paid

**Send-later and snooze need a faster tick.** With only the daily cron, a scheduled email or snooze can fire up to 24 hours late. The free fix is an external pinger. On [cron-job.org](https://cron-job.org) (free), create a job:

- URL: `https://cue-yourname.vercel.app/api/cron/scheduled-actions`
- Schedule: every 5 minutes
- Method: GET
- Header: `Authorization: Bearer <CRON_SECRET>`

At every 5 minutes that's about 8,600 short invocations a month, well inside Hobby's 1,000,000.

### Background jobs

Cue sends background jobs (digest items, automation runs, follow-up batches) through **Vercel Queues**. They are declared under `functions` in `apps/web/vercel.json` and available on Hobby, with 1,000,000 operations a month included. The meeting-recorder, Resend and Stripe queues are left out because those features are off on Hobby and each queue counts toward the 12-function limit. You don't need to set anything up.

---

## 8. Verify it works

1. Sign in with Google as an address on both lists. You should land in onboarding and then the inbox.
2. Sign in from an address **not** in `AUTH_ALLOWED_EMAILS` (add it as a Google test user first to get past Google). You should see **"Sign-up Restricted"**.
3. Open the assistant chat and ask "what's in my inbox today?". A streamed answer means the AI key works.
4. With Pub/Sub on: send yourself an email from another account. Within a few seconds it should appear in the open inbox. Check **Vercel → Logs** for `POST /api/google/webhook` returning 200.
5. **Settings → Cron Jobs**: click **Run** on `/api/watch/all`. It should return 200, not 401 (a 401 means `CRON_SECRET` is missing).
6. **Usage tab**: after a day, check Function invocations, Active CPU, and Provisioned Memory.

---

## 9. Troubleshooting

| Symptom | Fix |
|---|---|
| Build: `Invalid environment variables` | One of the required variables in step 3 is missing for that environment (Production vs Preview). |
| Build: `Either AUTH_SECRET or NEXTAUTH_SECRET…` | Set `AUTH_SECRET`. |
| Build: `MICROSOFT_WEBHOOK_CLIENT_STATE…` | You set `MICROSOFT_CLIENT_ID` without the client state. |
| Deploy: `No more than 12 Serverless Functions can be added to a Deployment on the Hobby plan` | Vercel bundles routes into one function only when their settings match. Keep every route's `maxDuration` at 30 or 300, and keep only the three queue routes in `apps/web/vercel.json`. Each queue route is its own function. |
| Build: `JavaScript heap out of memory` or the build is killed | Hobby's build machine has 8 GB. Add the env var `SKIP_TYPE_CHECK=true` to skip the type-check pass, which is the largest memory user. Type-check in CI or locally instead. |
| Build: `P1001` / can't reach database during `prisma migrate deploy` | Neon isn't connected to that environment. Fix it under Storage → your DB → Projects. |
| Google: `Error 400: redirect_uri_mismatch` | The URI in step 4.6 must match `NEXT_PUBLIC_BASE_URL` exactly: https, no trailing slash, same domain. |
| Google: "Access blocked: app has not completed verification" | The address isn't a **Test user** (step 4.4). |
| "Sign-up Restricted" for a friend | Add them to `AUTH_ALLOWED_EMAILS` and redeploy. |
| Everyone has to reconnect weekly | Expected for Testing-mode apps; see step 4. |
| New mail doesn't show up live / rules don't run | Check that the Pub/Sub subscription endpoint has the right `?token=`, that the topic has `gmail-api-push@…` as Publisher, and that Vercel logs show `/api/google/webhook`. Run the `/api/watch/all` cron by hand. |
| AI errors mentioning `429` or `RESOURCE_EXHAUSTED` | You hit the Gemini free limit. Wait for the window to reset, reduce automation rules, or add a paid fallback at the end of `DEFAULT_LLMS`. |
| Assistant chat stops mid-answer after about 5 minutes | Hobby caps every function at 300 s. Ask a narrower question. |
| Project paused | You went over a Hobby limit; check the Usage tab. Hobby pauses for the rest of the 30-day window. The usual cause is Provisioned Memory from inbox tabs left open: each visible inbox holds a 300 s live-update stream, and the stream closes when the tab is hidden. |

---

## How much AI quota do things use?

Rough calls per event, with the model tier each one uses:

- **Each incoming email, when the account has AI rules** (needs Pub/Sub): 1 rule-selection call (default). If a rule drafts a reply, add 3 to 6 more: context gathering, which can loop through tools; memory selection; and the draft itself (draft tier). Senders are categorized with 1 call (default) when auto-categorize is on, and attachment filing adds 1 call per attachment when it's on.
- **Each email you send**: about 1 to 2 calls (economy) for reply tracking and learning your writing style.
- **Opening the inbox**: 1 call (economy) per visible message not yet analyzed, at most 25 per request, cached for days. A first open of a large inbox can use 25 to 50 calls in a burst. On the free tier, that burst alone can trip the per-minute limit.
- **Onboarding a new account**: a one-time burst that analyzes writing style, persona, and recent history.
- **Assistant chat**: about 1 to 10 calls per message (chat tier), depending on tool use.

To keep within free limits, keep automation rules narrow, leave auto-drafting off for busy mailboxes, and set `AI_NANO_WEEKLY_SPEND_LIMIT_USD`.
