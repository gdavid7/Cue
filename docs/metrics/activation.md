# Activation metrics

Cue records eight activation events as structured server logs that ship to
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
| `activation.first_sync_ready` | The mail engine finished its first sync of the mailbox, as reported by the signed-in client | `emailAccountId`, `at`, `firstSignInAt`, `msSinceFirstSignIn` |
| `activation.first_thread_opened` | The first time a thread opens in the reader | `emailAccountId`, `at` |
| `activation.first_triage_action` | The first archive, snooze or reply done from Cue | `emailAccountId`, `at` |
| `activation.active_day` | The mailbox opens Mail or Today, at most once per UTC day | `emailAccountId`, `at`, `day` (`YYYY-MM-DD`) |
| `activation.first_hour_health` | Once per mailbox, from the daily `/api/cron/scheduled-actions` tick, for mailboxes between 60 minutes and 26 hours past first sign-in. The window outlives the longest gap between daily ticks, so every mailbox is covered once. Use `minutesSinceFirstSignIn` to tell an early snapshot from a late one. At most 200 per tick, oldest first | `emailAccountId`, `at`, `firstSignInAt`, `minutesSinceFirstSignIn`, `provider`, enabled rule counts and `replyTrackingEnabled`, ExecutedRule counts by status (`rulesApplied`, `rulesApplying`, `rulesSkipped`, `rulesSkippedNoMatch`, `rulesErrored`), `minutesSinceLastRuleRun`, `needsReplyCount`, `awaitingReplyCount`, `accountDisconnected`, `watchStatus` (`active`/`expired`/`missing`), `hasSyncCursor`, `errorTypes` (stored error type names) |

The last three come from the browser. The client reports each through one
authenticated server action, `recordActivationSignalAction`
(`apps/web/utils/actions/activation.ts`), whose input is only an event name
from a fixed list and whose mailbox must belong to the signed-in user. The
client sends each at most once per mailbox per page session and ignores a
failure. The server's Redis claim is the real dedupe. Mailboxes that finished a
sync before these events shipped log `first_sync_ready` on their next visit,
with a large `msSinceFirstSignIn`; the funnel query leaves out mailboxes that
signed in before `shippedAt`. Bulk "select all that match" archives run as a server
job and are not counted as a triage action.

The unit is the mailbox, because `emailAccountId` is the only id the events
carry. A person with two mailboxes counts as two.

How each event fires only once:
- `first_sign_in` is only called in the code that creates the mailbox. The
  mailbox's first sign-in time is `EmailAccount.createdAt`.
- Each "first" event, `first_sign_in` included, also claims a Redis key with
  `SET NX`, so a race still logs it once. The keys expire after 400 days,
  long past every metric window: `activation:first-sign-in:<id>`,
  `activation:needs-reply-first-item:<id>` and
  `activation:first-suggested-reply-sent:<id>`,
  `activation:first-sync-ready:<id>`, `activation:first-thread-opened:<id>` and
  `activation:first-triage-action:<id>`.
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

### First-run funnel

How many mailboxes reach each step after sign-in, and the median minutes it
takes. Use the same time range as above. Set `shippedAt` to the day the three
client events were deployed: mailboxes that signed in earlier have no
trustworthy first-run timings, and their late `first_sync_ready` would skew the
medians. A mailbox that skips a step (for example a triage before the reader
opens) still counts at the later step, so read each step as "reached", not
"reached in order".

```kusto
let shippedAt = datetime(2026-10-23);
['DATASET']
| where message in (
    "activation.first_sign_in",
    "activation.first_sync_ready",
    "activation.needs_reply_first_item",
    "activation.first_thread_opened",
    "activation.first_triage_action"
  )
| extend emailAccountId = tostring(['fields']['emailAccountId'])
| summarize
    signedInCount = countif(message == "activation.first_sign_in"),
    syncReadyCount = countif(message == "activation.first_sync_ready"),
    needsReplyCount = countif(message == "activation.needs_reply_first_item"),
    openedCount = countif(message == "activation.first_thread_opened"),
    triagedCount = countif(message == "activation.first_triage_action"),
    signedInAt = minif(_time, message == "activation.first_sign_in"),
    syncReadyAt = minif(_time, message == "activation.first_sync_ready"),
    needsReplyAt = minif(_time, message == "activation.needs_reply_first_item"),
    openedAt = minif(_time, message == "activation.first_thread_opened"),
    triagedAt = minif(_time, message == "activation.first_triage_action")
    by emailAccountId
| where signedInCount > 0 and todatetime(signedInAt) >= shippedAt
| summarize
    signedIn = count(),
    syncReady = countif(syncReadyCount > 0),
    needsReply = countif(needsReplyCount > 0),
    opened = countif(openedCount > 0),
    triaged = countif(triagedCount > 0),
    medianMinToSyncReady = percentileif(datetime_diff('second', todatetime(syncReadyAt), todatetime(signedInAt)) / 60.0, 50, syncReadyCount > 0),
    medianMinToNeedsReply = percentileif(datetime_diff('second', todatetime(needsReplyAt), todatetime(signedInAt)) / 60.0, 50, needsReplyCount > 0),
    medianMinToOpened = percentileif(datetime_diff('second', todatetime(openedAt), todatetime(signedInAt)) / 60.0, 50, openedCount > 0),
    medianMinToTriaged = percentileif(datetime_diff('second', todatetime(triagedAt), todatetime(signedInAt)) / 60.0, 50, triagedCount > 0)
```
