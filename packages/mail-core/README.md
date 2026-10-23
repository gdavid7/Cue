# @inboxzero/mail-core

Portable mailbox schemas, query semantics, command state, and the shared
engine API. This package has no React, DOM, SQL driver, or app-framework
dependencies.

Web and desktop construct the engine with a `MailStore`, a `MailboxSource`,
an `OperationExecutor`, and a `HostRuntime` (`nowMs`, `randomId`, `sha256`,
`storagePressure`). Attachments live on the provider's mailbox draft, so the
engine never holds their bytes.

Screens read `observeMailbox`, `observeMailboxWindow`, `observeConversation`,
and `observeOperation`. They save and read one draft with `saveDraft` /
`readDraft`, and queue a send with `submitSend`. A queued send is watched with `observeOperation`.

## Engine capabilities

The engine a page talks to can be older than the page: the desktop app loads
the deployed web app but runs the engine it was built with, and a follower tab
relays to whichever tab owns the engine. An older engine rejects a query order,
predicate kind or method it doesn't know, so features check first and choose a
shape up front:

```ts
import { mailClientSupports } from "@inboxzero/mail-core/capabilities";

const order = mailClientSupports(client, "order:oldest_first")
  ? "oldest_first"
  : "newest_first";
```

Each engine reports a list of features when the page connects, with no extra
round trip and no change to `MAIL_IPC_PROTOCOL_VERSION`:

| Feature | Meaning |
| --- | --- |
| `order:<order>` | `ConversationQuery.order` it accepts |
| `predicate:<kind>` | `MailPredicate` kind it accepts |
| `method:<name>` | optional `MailClient` method it answers |

| Engine | Where the report travels |
| --- | --- |
| Desktop | `window.inboxZeroDesktop.mailEngineCapabilities`, set by the preload from `apps/desktop/src/mail-engine/capabilities.ts` |
| Browser worker | the worker's answer to `start` |
| Owner tab | the `owner` reply to a follower's `hello`; a follower takes the new report when another tab takes over |

When an engine reports nothing (a build from before reporting), clients use
`BASELINE_MAIL_ENGINE_CAPABILITIES`: `order:newest_first`, the predicate kinds
that existed then, and no optional methods. Never add to the baseline. A new
order or predicate kind goes in the schema, and `capabilities.ts` fails the
type check until it is advertised too; a new optional method is advertised by
every host whose client answers it. Hosts ignore what they don't know, so an
older page on a newer engine and a newer page on an older engine both keep
working. `mailClientSupports` also checks that the client itself can relay a
reported method.

Account lists, Outlook folders, and Gmail labels stay on their existing server
APIs.

Forbidden imports: React, DOM globals, IndexedDB, Electron, Expo, Next, Prisma,
Redis, and Node-only modules.
