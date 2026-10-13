# Cue: product notes

## The idea in one line

Connect the inboxes you already have, and Cue shows you what actually needs you today, with everything you'd otherwise go searching for already found.

## Who it's for

The original concept brief aimed at high-email knowledge workers (founders, recruiters, PMs). **Cue is for everyday people**: parents, renters, patients, people running a household, adult children looking after their parents. Their email isn't a work queue. It's the logistics of life:

- **School and kids' activities**: schedule changes, forms to sign, picture day
- **Home**: lease renewals, landlord notices, repair quotes, utility bills
- **Health**: appointment confirmations, insurance letters
- **Family and friends**: "which day are you flying in?", "can you Venmo me?"
- **Money and shopping**: bills, receipts, deliveries, refunds
- **Noise**: newsletters and promotions, which are most of the volume

Two things are especially true for this audience:

1. **They have more than one inbox.** An old Hotmail or Yahoo address from 2009 still gets the airline confirmations, and the "new" Gmail gets everything else. The answer to an email in one inbox often lives in the other. In the demo, Mom asks in Gmail which day you're flying in; the flight is in Outlook.
2. **They don't triage for a living.** Nobody sets up filters or labels. The product has to work with zero configuration, and it has to be trustworthy enough that people let it act.

## What changed from the brief, and why

| Brief (knowledge workers) | Cue (everyday people) | Why |
|---|---|---|
| Needs me / Agent working / Waiting / Handled | **Needs you / Cue is on it / Waiting / Taken care of** | Plain language. "Agent" is jargon |
| Gmail + Outlook + Calendar + Drive + Slack | Gmail + Outlook/Hotmail + Calendar + Drive (later: Yahoo/iCloud over IMAP, photos, a bank or bill-pay link) | Slack, CRM and GitHub are work tools. Consumers' context lives in calendars, files, and old inboxes |
| Projects, companies, deals | **Life topics**: "Maya's soccer", "Apartment & lease", "Thanksgiving trip" | The organizing unit of a household |
| Context for decisions at work | Context for decisions at home: *is this rent increase allowed?* *Do we have a conflict Saturday?* | Same machinery, different questions |
| Autonomy up to user-defined automatic handling | **Conservative defaults.** Only private, reversible actions run automatically (filing noise, calendar holds, bill reminders). Anything outward-facing always waits for you | Trust is earned slowly with consumers, and a wrong auto-reply to your landlord is costly |
| Desktop client (Mailspring fork) | **Web first, mobile next** | Everyday email happens on phones. See the stack note below |

## The magic moment

You open an email and Cue has already done the digging:

- *"Found 'Maya – Medical Release Form (signed).pdf' in your Drive."* (and not the blank copy)
- *"Heads up: Leo's birthday party starts at 10:00 AM, right after."*
- *"$2,150 is +$100 (4.9%) vs. your current $2,050, within the 5% cap in your lease."*
- *"From your Old inbox (Outlook): Departing Wednesday, Nov 25, UA 1432, landing PDX 5:58 PM."*

Then there's one button that does the thing: send the reply with the form attached, add the game to the calendar, set a reminder before the deadline.

**Adoption message:** "Connect your inboxes and see what actually needs you today."
**Value metric:** searches saved, meaning times Cue found something so you didn't have to open another app. It's shown in the header.

## Trust and safety principles

1. **Show your work.** Every piece of context shows *how* it was found ("Found via Dana Kim → Hornets practice") and flags uncertainty ("85% sure", "may be outdated").
2. **Code decides facts and actions; the LLM writes words.** Conflicts, deadlines, money math, and which file to attach are computed deterministically. The model has no tools.
3. **Email is untrusted input.** Anyone can email you, so prompt-injection resistance is a product requirement, not a nice-to-have. A malicious email can at worst produce a bad draft that you'll see before it's sent.
4. **Everything is logged and reversible where possible.** The activity log shows what happened and whether you or a rule did it. Low-risk actions have Undo.
5. **Rules are visible and few.** Three plain-English toggles, not a rules engine.

## Notes on the brief's stack

- **Mailspring.** It's a solid open-source multi-account client, but it's a desktop Electron app and it's **GPLv3**: shipping a fork means releasing Cue's client under GPLv3 too. For an everyday-people product that will mostly be used on phones, talking to provider APIs directly (Gmail API, Microsoft Graph, IMAP for the rest) from a web or mobile client is probably the better base. This needs a decision before real connectors get built.
- **Gmail API verification.** Reading Gmail needs Google's *restricted* scopes, which for a public app means OAuth verification plus an annual third-party security assessment. That takes time and money, so plan for it early. Outlook and IMAP have lighter requirements.
- **LLM cost per user.** Consumers pay less than enterprises. Cue only sends threads to the LLM after noise is filtered out (newsletters and receipts never reach the model), and everything works on the heuristic brain if the LLM is unavailable.
- **Composio, Graphiti, Postgres** fit as planned. See the mapping table at the end of [ARCHITECTURE.md](ARCHITECTURE.md).

## Roadmap

1. **Real accounts.** Gmail and Outlook connectors with incremental sync. Write actions back to the source (send from the right account, archive in the source inbox, create real calendar events).
2. **Persistence.** Postgres for users, accounts, actions, rules, and the audit log. A real graph store (Graphiti).
3. **Better understanding.** LLM-extracted topics and facts instead of keyword seeds and regexes, and embeddings instead of TF-IDF.
4. **Learning from feedback.** Dismissals and edits to drafts become ranking and drafting signals.
5. **Mobile.** A mobile client, and a morning notification: "2 things need you today".
6. **More sources** where everyday context lives: iCloud and Yahoo over IMAP, photos (for "send me the pictures from…"), and bill pay.

## Open questions

- Which inboxes do target users actually have? A short survey of 20–30 people would settle the connector order.
- Should "Taken care of" items disappear after a day, or stay as a record?
- Shared households: should two parents see the same "Maya's soccer" topic?
- How much automation do people want by default? Test the three rules as default-on vs default-off.
