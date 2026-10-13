# How Cue works

This document walks through Cue's pipeline from first principles. Each section says what problem the step solves, how Cue solves it, and where the code lives. The running example is the demo email from Coach Dana:

> *Hi Alex, the rained-out game is rescheduled to this Saturday, Oct 17 at 9:00am at Garfield Park. Can Maya make it? Also, I still don't have her signed medical release form. Could you send it over before Saturday?*

A human answering this would check the calendar for Saturday, dig through Drive for the form (the *signed* one), and then reply with it attached. Cue's job is to do that digging before you open the email.

```
 Gmail ─┐                                                     ┌─▶ summary, what matters
Outlook ─┤   ┌───────────┐   ┌──────────┐   ┌─────────────┐   │
Calendar ─┼─▶│ normalize │──▶│ resolve  │──▶│  knowledge  │   │   ┌──────────┐   ┌─────────┐
  Drive ─┘   └───────────┘   │ entities │   │    graph    │──▶├─▶ │ planner  │──▶│ autonomy│──▶ executor
                             └──────────┘   └─────────────┘   │   └──────────┘   └─────────┘
                                        intent ─▶ traverse ─▶ rerank ─▶ signals ─▶ brain (words)
```

---

## 1. Normalization: one shape for every source

**Problem.** Gmail returns `payload.headers[{name:"From", value:"Dana Kim <dana@…>"}]` with a base64 body. Outlook returns `from.emailAddress.address`. Calendar has `attendees[]` and Drive has `owners[]`. If every later step had to understand every provider, adding a new one would mean touching everything.

**Solution.** Translate each provider's format into a small shared model (`Message`, `CalendarEvent`, `Doc`) as soon as it arrives. Each object keeps a `Provenance` (provider, source id, account), so anything Cue says later can be traced back to where it came from.

Code: `src/ingest/normalize.ts`, `src/core/types.ts`. A connector (`src/ingest/connectors.ts`) is anything with a `sync(cursor)` method. The demo connector replays fixtures; a real one would call the Gmail API, or go through an integration layer like Composio that handles OAuth and token refresh.

## 2. Entity resolution: is this the same person?

**Problem.** Dana emails from `dana.kim@eastsideyouthsoccer.org` as "Dana Kim". The practice invite on the calendar lists `dana.hornets@gmail.com` as "Coach Dana". To a computer those are two strangers. If Cue can't connect them, it can't answer "what do I know about the person who sent this email?"

**Solution: deterministic first, fuzzy only when needed.**

1. **Exact match.** If we've seen this email address before, it's the same person, with confidence $1.0$. Most links are made this way: reliable and cheap.
2. **Fuzzy match.** Otherwise, compare names after stripping titles ("Coach", "Dr"):

$$
\text{nameScore} = \begin{cases}
0.85 & \text{if every name token matches} \\
0.6 \cdot \dfrac{|\text{shared tokens}|}{\min(|A|, |B|)} & \text{otherwise}
\end{cases}
$$

   A shared first name on its own is weak evidence; lots of people are called Dana. So Cue adds **corroborating context**: of the words around this new identity (the event title and location), what fraction have we already seen with the candidate person?

$$
\text{score} = \text{nameScore} + 0.25 \cdot \frac{|\text{context words} \cap \text{words seen with person}|}{|\text{context words}|}
$$

   For Coach Dana: "dana" is shared ($0.6 \cdot 1/1 = 0.6$), and all four context words ("hornets", "practice", "garfield", "park") have appeared in Dana Kim's emails ($+0.25 \cdot 4/4$). That totals $0.85$, above the merge threshold of $0.7$. A "Dana Smith" emailing about a cake order would score $0.6 \cdot \tfrac{1}{2} + 0 = 0.3$ and stay a separate person.
3. **The confidence is kept.** Edges created through a fuzzy match carry a confidence of $0.85$, not $1.0$. The UI shows "85% sure" on anything found through that link, so a wrong guess is visible instead of silently treated as fact.

Code: `src/resolve/entities.ts`. Tests: `test/resolve.test.ts`.

## 3. The temporal knowledge graph

**Problem.** Search engines treat your data as a pile of documents. But the useful structure is *relationships*: Dana sent this email, this email is about Maya's soccer, this form belongs to that topic, you own this lease, and Priya can see it.

**Solution.** Store a graph. **Nodes** are things (person, org, thread, message, event, doc, topic, fact). **Edges** are typed relationships:

```
person ──sent──▶ message ──in_thread──▶ thread ──about──▶ topic
person ──attended──▶ event        person ──works_at──▶ org
person ──owns──▶ doc ──shared_with──▶ person        doc ──states──▶ fact
```

Every edge has `validFrom`, an optional `validTo`, a `confidence`, and a `source`. That's what makes it **temporal**: facts are true *for a period*. The lease PDF says "Term: Nov 1, 2025 to Oct 31, 2026. Monthly rent: $2,050", so the fact `rent = 2050` is valid only in that window. When a newer agreed fact with the same key arrives, the old edge is closed (`validTo` is set) rather than deleted. Cue can still answer "what *was* the rent?", and it can flag stale context instead of presenting it as current. Offers ("we're offering $2,150/month") are stored as *proposed* facts and don't replace the agreed value.

Topics ("Maya's soccer", "Thanksgiving trip") group things that belong together even when different people and apps are involved. In the demo they're seeded with keywords. In production an LLM extractor (for example Graphiti's) would propose them.

Code: `src/graph/graph.ts` (the store), `src/graph/build.ts` (objects to nodes and edges), `src/graph/facts.ts` (fact extraction). The `TemporalGraph` interface is small on purpose, so a Graphiti/Neo4j backend can replace it.

## 4. Intent: what is this email asking for?

**Problem.** "Find relevant context" means different things for different emails. A scheduling email needs the calendar. A document request needs Drive. A decision needs the facts behind it.

**Solution.** Classify intent first, then let it steer retrieval. Cue scores each intent with weighted patterns (`src/intent/classify.ts`), and an email can have several. Dana's email is **scheduling** ("9:00am", "can Maya make it"), a **document request** ("send it over… form"), and a **question**. Cue also extracts dates relative to "now". "This Saturday, Oct 17" becomes `2026-10-17`, but a bare "Wednesday or Thursday for Thanksgiving" is left alone, because it doesn't mean *this* Wednesday.

When Claude is enabled it also returns an intent, but planning keeps using the rule-based one so actions stay predictable.

## 5. Retrieval: traverse first, then rank

This is the core idea of the concept brief: **don't dump the whole workspace into a vector search.** Use structure to shrink the search space, then use similarity to pick the best evidence.

### 5a. Traversal (structure)

Start from **anchors**: the thread and everyone on it, *except the user*. You're connected to everything, so walking through yourself would make every node look relevant. Then walk outward breadth-first, up to 3 hops, keeping the strongest path to each node. A path's strength is the product of its edge confidences:

$$
\text{pathConfidence} = \prod_{e \in \text{path}} \text{confidence}(e)
$$

Dana's thread reaches:
- `Dana Kim → Hornets practice` (1 hop, confidence 0.85 because of the fuzzy link)
- `thread → Maya's soccer → Medical Release Form (signed).pdf` (2 hops)

Time is a dimension too. For scheduling intents, events on the mentioned dates join the candidates even if nobody on the thread is invited. That's how **Leo's birthday party** on Saturday shows up.

### 5b. Reranking (similarity + priors)

Each candidate gets a score:

$$
\text{score} = 0.40\,\text{sem} + 0.15\,\text{recency} + 0.20\,\text{structure} + 0.15\,\text{prior} + 0.25\,\text{dateMatch}
$$

| Term | Meaning |
|---|---|
| $\text{sem}$ | Cosine similarity between the email and the candidate's text (TF-IDF, below) |
| $\text{recency}$ | $e^{-\lvert\Delta \text{days}\rvert / 30}$: newer is more relevant, decaying over about a month |
| $\text{structure}$ | $\text{pathConfidence} / \text{hops}$: closer, surer links count more |
| $\text{prior}$ | How useful this *kind* of item is for this intent, for example docs for a document request |
| $\text{dateMatch}$ | 1 if it's a calendar event on a date the email mentions |

**TF-IDF cosine similarity**, the stand-in for embeddings. Turn each text into a vector with one dimension per word. A word's weight is how often it appears (TF) times how *rare* it is across everything Cue has seen (IDF):

$$
w_{t} = \text{tf}(t) \cdot \ln\!\left(1 + \frac{N+1}{\text{df}(t)+1}\right)
\qquad
\text{sim}(a,b) = \frac{\vec a \cdot \vec b}{\lVert \vec a\rVert\,\lVert \vec b\rVert}
$$

Rare words like "signed" carry more weight than common ones like "form". That's why the *signed* release form outranks the blank one: both mention "medical release form", but only one also says "signed", which matches Dana's email. Real embeddings capture meaning beyond shared words ("flight" ≈ "flying in"). Swapping them in only changes `Corpus.similarity`.

**Picking the final set.** Keep the top $k = 4$, drop anything scoring below half the best hit (two great items beat two great plus two weak), then make sure each intent's key kind is covered. Dana asks for a form *and* a time, so a Drive file and a calendar event both have to make it in.

Code: `src/retrieve/context.ts`, `src/retrieve/text.ts`.

## 6. Signals, then words

**Problem.** LLMs write well but can get facts wrong, and email is full of untrusted text.

**Solution: split the work.** Code computes **signals**, verifiable facts about the thread (`src/engine.ts → computeSignals`):

- deadline: "Needed by Sat, Oct 17 (in 4 days)"
- proposed time and same-day events, with overlap checks done arithmetically in the user's time zone
- the best document to attach
- facts from the thread and the context, for example rent $2,050 (current) vs $2,150 (offered), 5% cap
- cross-inbox finds: context from a different account than the thread
- how long you've been waiting for a reply

A **brain** turns signals into language: a summary, "what matters", and reply drafts.

- `HeuristicBrain` (`src/agent/heuristics.ts`) uses templates. It's deterministic and works offline.
- `ClaudeBrain` (`src/agent/claude.ts`) sends the thread and signals to Claude and gets back structured JSON, validated against a Zod schema. Any failure (network error, refusal, bad output) falls back to the heuristic brain.

The model **has no tools**. It can't send, delete, or schedule anything. Email text goes in as quoted data, and the system prompt says to describe instructions inside emails, never follow them. Even a successful prompt injection could only produce a bad *draft*, which you still have to approve.

## 7. Actions, risk, and progressive autonomy

The planner (`src/agent/plan.ts`) turns signals into concrete actions, each with a **risk level**:

| Risk | Examples | Who approves |
|---|---|---|
| low | archive, add a calendar event, set a reminder | can run automatically if a rule you control allows it |
| medium | nudge someone who hasn't replied | you |
| high | send a reply | you, always |

Autonomy is **progressive**: read-only, then suggestions, then drafts, then one-click actions, then automatic handling through explicit rules. Cue ships with three rules, all low-risk and reversible: file newsletters and receipts, add school and activity dates to the calendar, and remind you two days before bills are due. You can switch each one off in *Settings & activity*. Everything Cue does is written to the audit log with *who* did it ("by you" or "automatically (rule: …)"). Low-risk actions can be undone; sent mail can't.

## 8. Triage: the four lanes

Lane assignment is product logic, not an LLM call (`src/triage/buckets.ts`):

```
running action?                         → Cue is on it
archived?                               → Taken care of
your message is last and asks something → Waiting
newsletter / receipt                    → Taken care of
a rule did the routine part, nothing
  needing judgment left                 → Taken care of
otherwise                               → Needs you
```

"Needs you" is sorted by a priority score that adds up deadline urgency, family, calendar conflicts, and intent. Each card shows the main reason ("Due in 4 days", "Family").

## 9. Measuring value

The brief's value metric is *how often Cue saves you from leaving the email to search another app*. Each time you open a thread, Cue counts the context items that came from a different account or app than the thread itself, and shows the total in the header as "searches saved".

---

## Mapping to the concept brief's stack

| Brief | This prototype | To get to production |
|---|---|---|
| Mailspring (mail sync + client) | `SourceConnector` + demo fixtures; web UI | Real Gmail/Graph API connectors with incremental sync (history IDs, delta tokens). See the note on Mailspring in PRODUCT.md |
| Composio (OAuth, actions) | In-memory executor | Executor calls Gmail/Calendar/Drive through Composio; results sync back to the source inbox |
| Graphiti (temporal KG) | `TemporalGraph` | Graphiti on Neo4j/FalkorDB; LLM-based entity and fact extraction instead of keyword topics and regex facts |
| Postgres (app state) | In-memory `Cue` state | Users, accounts, actions, audit log, and rules in Postgres |
| LLM + embeddings | Claude via `ClaudeBrain`; TF-IDF | Add a real embedding model inside `Corpus.similarity` |
| "Flux layer" (product logic) | `triage/`, `agent/plan.ts`, `retrieve/` | This is the differentiated part. Keep it custom |
