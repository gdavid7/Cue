# Activation metrics

Cue records five activation events as structured server logs that ship to
Axiom. There is no separate analytics vendor. The definitions live in
`apps/web/utils/analytics/activation.ts`.

## Events

Each event is an info log in the `product` scope. Its `message` is the event
name. Its fields are the mailbox id, timestamps and aggregate counts or states
only: no addresses, subjects or content.

| Event (`message`) | When | Fields |
| --- | --- | --- |
| `activation.first_sign_in` | A mailbox is created, either at sign-in or when another mailbox is linked | `emailAccountId`, `at` |
| `activation.needs_reply_first_item` | The first time Needs reply has an item for the mailbox | `emailAccountId`, `at`, `firstSignInAt`, `msSinceFirstSignIn` |
| `activation.first_suggested_reply_sent` | The first sent reply that started from a reply Cue wrote: a saved suggested reply or an AI draft, sent rather than discarded | `emailAccountId`, `at` |
| `activation.active_day` | The mailbox opens Mail or Today, at most once per UTC day | `emailAccountId`, `at`, `day` (`YYYY-MM-DD`) |
| `activation.first_hour_health` | Once per mailbox, from the frequent `/api/cron/scheduled-actions` tick, for mailboxes between 60 minutes and 26 hours past first sign-in, so usually soon after the hour. The window outlives the gap between daily ticks too, so a deployment limited to a daily cron (Vercel Hobby) still covers every mailbox once. Use `minutesSinceFirstSignIn` to tell an early snapshot from a late one. At most 200 per tick, oldest first | `emailAccountId`, `at`, `firstSignInAt`, `minutesSinceFirstSignIn`, `provider`, enabled rule counts and `replyTrackingEnabled`, ExecutedRule counts by status (`rulesApplied`, `rulesApplying`, `rulesSkipped`, `rulesSkippedNoMatch`, `rulesErrored`), `minutesSinceLastRuleRun`, `needsReplyCount`, `awaitingReplyCount`, `accountDisconnected`, `watchStatus` (`active`/`expired`/`missing`), `hasSyncCursor`, `errorTypes` (stored error type names) |

The unit is the mailbox, because `emailAccountId` is the only id the events
carry. A person with two mailboxes counts as two.

How each event fires only once:
- `first_sign_in` is only called in the code that creates the mailbox. The
  mailbox's first sign-in time is `EmailAccount.createdAt`.
- Each "first" event, `first_sign_in` included, also claims a Redis key with
  `SET NX`, so a race still logs it once. The keys expire after 400 days,
  long past every metric window: `activation:first-sign-in:<id>`,
  `activation:needs-reply-first-item:<id>` and
  `activation:first-suggested-reply-sent:<id>`.
- `first_hour_health` claims `activation:first-hour-health:<id>`, which
  expires after three days, and releases it if the snapshot fails so a later tick
  retries.
- `active_day` claims `activation:active-day:<id>:<day>`, which expires after
  two days.

Mailboxes created before these events shipped have no `first_sign_in`. Their
"first" events can still appear, but the queries below start from
`first_sign_in`, so those mailboxes are left out.

## Queries

Replace `DATASET` with the app's Axiom dataset (`NEXT_PUBLIC_AXIOM_DATASET`).
Set the time range to cover the cohort's sign-ups plus 14 days. `min(_time)`
comes back as a number, so each query turns it back into a datetime.

### Aha

Needs reply shows at least one email within 10 minutes of first sign-in.
Target: 80% of mailboxes.

```kusto
['DATASET']
| where message == "activation.first_sign_in"
| summarize signedInAt = min(_time) by emailAccountId = tostring(['fields']['emailAccountId'])
| extend signedInAt = todatetime(signedInAt)
| join kind=leftouter (
    ['DATASET']
    | where message == "activation.needs_reply_first_item"
    | summarize msToFirstItem = min(toreal(['fields']['msSinceFirstSignIn'])) by emailAccountId = tostring(['fields']['emailAccountId'])
  ) on emailAccountId
| summarize mailboxes = count(), aha = countif(msToFirstItem <= 600000)
| extend ahaRate = todouble(aha) / mailboxes
```

### Activated

At least one reply sent within 7 days of first sign-in that started from a
Cue suggestion. Target: 50% or more. Only mailboxes that signed in at least
7 days ago are counted.

```kusto
['DATASET']
| where message == "activation.first_sign_in"
| summarize signedInAt = min(_time) by emailAccountId = tostring(['fields']['emailAccountId'])
| extend signedInAt = todatetime(signedInAt)
| where signedInAt < ago(7d)
| join kind=leftouter (
    ['DATASET']
    | where message == "activation.first_suggested_reply_sent"
    | summarize sentAt = min(_time) by emailAccountId = tostring(['fields']['emailAccountId'])
    | extend sentAt = todatetime(sentAt)
  ) on emailAccountId
| summarize mailboxes = count(), activated = countif(isnotnull(sentAt) and sentAt - signedInAt <= 7d)
| extend activationRate = todouble(activated) / mailboxes
```

### Retained

Active on at least 3 of the first 7 days and on at least 1 day in week 2.
Target: 60% or more. Only mailboxes that signed in at least 14 days ago are
counted.

```kusto
['DATASET']
| where message == "activation.first_sign_in"
| summarize signedInAt = min(_time) by emailAccountId = tostring(['fields']['emailAccountId'])
| extend signedInAt = todatetime(signedInAt)
| where signedInAt < ago(14d)
| join kind=leftouter (
    ['DATASET']
    | where message == "activation.active_day"
    | project emailAccountId = tostring(['fields']['emailAccountId']), activeAt = _time, day = tostring(['fields']['day'])
  ) on emailAccountId
| extend sinceSignIn = activeAt - signedInAt
| summarize
    week1Days = dcountif(day, sinceSignIn >= 0d and sinceSignIn < 7d),
    week2Days = dcountif(day, sinceSignIn >= 7d and sinceSignIn < 14d)
    by emailAccountId
| summarize mailboxes = count(), retained = countif(week1Days >= 3 and week2Days >= 1)
| extend retentionRate = todouble(retained) / mailboxes
```
