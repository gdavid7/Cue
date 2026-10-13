// Cue's engine: runs the pipeline end to end and holds product state.
//
//   connectors ─▶ normalize ─▶ resolve entities ─▶ knowledge graph
//        ─▶ per thread: classify intent ─▶ traverse + rerank context ─▶ signals
//        ─▶ brain (words) + planner (actions) ─▶ autonomy rules ─▶ executor
//        ─▶ four lanes on the home screen, with an audit log of everything done.

import type { Account, Action, Analysis, Bucket, ContextItem, Intent, Message } from "./core/types.ts";
import { daysBetween, formatLocal, localDate, zonedToUtc } from "./core/time.ts";
import type { Brain, DayEvent, FactSignal, Signals } from "./agent/brain.ts";
import { HeuristicBrain, sentences } from "./agent/heuristics.ts";
import { type AutonomyRule, defaultRules, planActions } from "./agent/plan.ts";
import { buildGraph, type TopicSeed } from "./graph/build.ts";
import type { TemporalGraph } from "./graph/graph.ts";
import type { SourceConnector } from "./ingest/connectors.ts";
import { classify, extractDates } from "./intent/classify.ts";
import { EntityResolver, SELF_ID } from "./resolve/entities.ts";
import { retrieveContext } from "./retrieve/context.ts";
import { Corpus } from "./retrieve/text.ts";
import { bucketOf, priorityOf } from "./triage/buckets.ts";

export interface CueOptions {
  userName: string;
  accounts: Account[];
  family: { email: string; label: string }[];
  connectors: SourceConnector[];
  topics: TopicSeed[];
  tz: string;
  /** Fixed clock for demos/tests; defaults to the real time. */
  now?: () => string;
  brain?: Brain;
  /** Simulated execution time per action, so "Cue is on it" is visible in the demo. */
  actionDelayMs?: number;
}

interface ThreadState {
  id: string;
  subject: string;
  accountId: string;
  messages: Message[];
  archived: boolean;
  intent: Intent;
  signals: Signals;
  analysis: Analysis;
  actions: Action[];
}

export interface AuditEntry {
  at: string;
  threadId: string;
  actionId: string;
  by: string; // "you" or "rule:<id>"
  text: string;
}

export interface Card {
  threadId: string;
  subject: string;
  from: string;
  account: string;
  summary: string;
  when: string;
  reason?: string;
  note?: string;
  priority: number;
}

export class Cue {
  readonly opts: CueOptions;
  readonly rules: AutonomyRule[] = defaultRules();
  readonly audit: AuditEntry[] = [];
  readonly reminders: { at: string; note: string; actionId: string }[] = [];
  graph!: TemporalGraph;
  private resolver!: EntityResolver;
  private corpus!: Corpus;
  private threads = new Map<string, ThreadState>();
  private actions = new Map<string, Action>();
  private seq = 0;
  private brain: Brain;
  private heuristic = new HeuristicBrain();
  /** The brief's value metric: times Cue saved the user from searching another app. */
  readonly metrics = { appSearchesSaved: 0, threadsOpened: new Set<string>() };

  constructor(opts: CueOptions) {
    this.opts = opts;
    this.brain = opts.brain ?? this.heuristic;
  }

  now(): string {
    return this.opts.now?.() ?? new Date().toISOString();
  }

  // -------------------------------------------------------------------------
  // Sync + analysis

  async sync(): Promise<void> {
    const objects = (await Promise.all(this.opts.connectors.map((c) => c.sync()))).flatMap((r) => r.objects);
    const selfEmails = this.opts.accounts.map((a) => a.address);
    this.resolver = new EntityResolver(this.opts.userName, selfEmails);
    const built = buildGraph(objects, this.resolver, this.opts.topics);
    this.graph = built.graph;

    this.corpus = new Corpus();
    for (const n of this.graph.nodes.values()) this.corpus.add(`${n.label} ${n.props.body ?? n.props.text ?? ""}`);

    const byThread = new Map<string, Message[]>();
    for (const m of built.messages.values()) byThread.set(m.threadId, [...(byThread.get(m.threadId) ?? []), m]);
    for (const [id, msgs] of byThread) {
      msgs.sort((a, b) => a.sentAt.localeCompare(b.sentAt));
      const prev = this.threads.get(id);
      const state = {
        id,
        subject: msgs.at(-1)!.subject.replace(/^(re|fwd?):\s*/i, ""),
        accountId: msgs[0].source.accountId,
        messages: msgs,
        archived: prev?.archived ?? false,
        actions: prev?.actions ?? [],
      } as ThreadState;
      this.threads.set(id, state);
      this.analyzeSync(state);
    }

    // Upgrade the wording with the LLM in the background, a few threads at a time.
    if (this.brain !== this.heuristic) void this.refineAll();
  }

  /** Deterministic pass: signals → heuristic words → planned actions → autonomy. */
  private analyzeSync(t: ThreadState) {
    const { intent, signals } = this.computeSignals(t);
    t.intent = intent;
    t.signals = signals;
    t.analysis = this.heuristic.analyzeNow(signals);
    this.replan(t);
  }

  private async refineAll() {
    const queue = [...this.threads.values()].filter((t) => t.intent !== "newsletter" && t.intent !== "receipt");
    const worker = async () => {
      for (let t = queue.shift(); t; t = queue.shift()) {
        const analysis = await this.brain.analyze(t.signals);
        t.analysis = analysis;
        this.replan(t);
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  /** Re-plan actions while keeping anything already approved, running, done, or dismissed. */
  private replan(t: ThreadState) {
    const isReply = (a: Action) => a.kind === "send_reply" || a.kind === "nudge";
    const kept = t.actions.filter((a) => a.status !== "proposed" || (t.signals.lastFromMe && !isReply(a)));
    const fresh = planActions(t.signals, t.analysis, t.intent, () => `act_${++this.seq}`).filter((a) =>
      isReply(a)
        ? !kept.some((k) => isReply(k) && (k.status === "running" || (k.status === "dismissed" && k.params.option === a.params.option)))
        : !kept.some((k) => k.kind === a.kind),
    );
    t.actions = [...kept, ...fresh];
    for (const a of t.actions) this.actions.set(a.id, a);

    for (const a of t.actions) {
      if (a.status !== "proposed" || a.risk !== "low") continue;
      const rule = this.rules.find((r) => r.enabled && r.matches(a, t.intent, t.signals, t.analysis));
      if (rule) {
        a.autoRule = rule.id;
        this.run(a, `rule:${rule.id}`);
      }
    }
  }

  private computeSignals(t: ThreadState): { intent: Intent; signals: Signals } {
    const { tz } = this.opts;
    const now = this.now();
    const last = t.messages.at(-1)!;
    const lastFromMe = this.isMe(last.from.email);
    const counterpartIdentity = lastFromMe ? last.to[0] : last.from;
    const cp = this.resolver.resolve(counterpartIdentity);
    const person = this.resolver.people.get(cp.personId)!;
    const familyEntry = this.opts.family.find((f) => person.emails.has(f.email));
    const text = `${last.subject} ${last.body}`;
    const { primary, all } = classify(text, person.automated);
    const dates = lastFromMe ? [] : extractDates(last.body, now);

    const context = retrieveContext({ graph: this.graph, corpus: this.corpus, threadId: t.id, query: text, intents: all, dates, now, tz });

    // Deadline: "confirm by Oct 20", "Due date: Oct 24, 2026", "before Saturday".
    let deadline: Signals["deadline"];
    for (const dl of lastFromMe ? [] : last.body.matchAll(/\b(confirm by|reply by|by|before|due(?: date)?:?)\s+((?:this |next )?[a-z]+\.?(?: \d{1,2})?(?:, \d{4})?)/gi)) {
      const phrase = /^(sun|mon|tues|wednes|thurs|fri|satur)day$/i.test(dl[2]) ? `this ${dl[2]}` : dl[2];
      const d = extractDates(phrase, now)[0];
      if (!d) continue;
      const date = zonedToUtc(d, 12, 0, tz);
      const label = /due/i.test(dl[1]) ? "Due" : /confirm/i.test(dl[1]) ? "Confirm by" : /reply/i.test(dl[1]) ? "Reply by" : "Needed by";
      deadline = { date, label, daysLeft: Math.round(daysBetween(zonedToUtc(localDate(now, tz), 12, 0, tz), date)) };
      break;
    }

    // Proposed time for scheduling emails, and what else is on the calendar that day.
    let proposedTime: Signals["proposedTime"];
    let sameDayEvents: DayEvent[] = [];
    if (all.includes("scheduling") && dates.length) {
      const tm = last.body.match(/\b(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
      if (tm) {
        const h = (Number(tm[1]) % 12) + (tm[3].toLowerCase() === "pm" ? 12 : 0);
        const start = zonedToUtc(dates[0], h, Number(tm[2] ?? 0), tz);
        const end = new Date(Date.parse(start) + 3_600_000).toISOString();
        proposedTime = { start, end, label: formatLocal(start, tz), allDay: false };
      } else {
        const start = zonedToUtc(dates[0], 0, 0, tz);
        proposedTime = { start, end: new Date(Date.parse(start) + 86_400_000).toISOString(), label: `${formatLocal(zonedToUtc(dates[0], 12, 0, tz), tz, false)} (all day)`, allDay: true };
      }
      sameDayEvents = this.graph
        .byKind("event")
        .filter((e) => localDate(String(e.props.start), tz) === dates[0])
        .map((e) => {
          const start = String(e.props.start);
          const end = String(e.props.end);
          return { title: e.label, start, end, overlaps: !proposedTime!.allDay && start < proposedTime!.end && end > proposedTime!.start };
        })
        .sort((a, b) => a.start.localeCompare(b.start));
    }

    // Facts stated by this thread's messages and by the context we found.
    const facts: FactSignal[] = [];
    const factSources = [...t.messages.map((m) => m.id), ...context.map((c) => c.nodeId)];
    for (const id of factSources) {
      for (const { node } of this.graph.neighbors(id, { types: ["states"], at: now })) {
        facts.push({ key: String(node.props.key), value: Number(node.props.value), text: node.label, proposed: !!node.props.proposed, from: this.graph.nodes.get(id)?.label ?? id });
      }
    }

    const crossInbox = context
      .filter((c) => c.kind === "message" && c.source && c.source.accountId !== t.accountId)
      .map((item) => ({
        item,
        accountLabel: this.opts.accounts.find((a) => a.id === item.source!.accountId)?.label ?? "other inbox",
        sentence: bestSentence(String(this.graph.nodes.get(item.nodeId)?.props.body ?? item.snippet), text, this.corpus),
      }));

    const firstName = this.opts.userName.split(" ")[0];
    const signals: Signals = {
      threadId: t.id,
      subject: last.subject,
      messages: t.messages,
      lastFromMe,
      counterpart: {
        name: familyEntry?.label ?? person.name,
        greetingName: familyEntry?.label ?? person.name.split(" ")[0],
        family: !!familyEntry,
        automated: person.automated,
      },
      intents: all,
      deadline,
      proposedTime,
      sameDayEvents,
      bestDoc: all.includes("document_request") ? context.find((c) => c.kind === "doc") : undefined,
      context,
      facts,
      crossInbox,
      waitingDays: lastFromMe ? daysBetween(last.sentAt, now) : undefined,
      user: { name: this.opts.userName, firstName },
      now,
      tz,
    };
    return { intent: primary, signals };
  }

  private isMe(email?: string) {
    return !!email && this.resolver.resolve({ email }).personId === SELF_ID;
  }

  // -------------------------------------------------------------------------
  // Views

  bucket(t: ThreadState): Bucket {
    const last = t.messages.at(-1)!;
    return bucketOf({
      intent: t.intent,
      lastFromMe: t.signals.lastFromMe,
      lastMineAsks: /\?/.test(last.body),
      waitingDays: t.signals.waitingDays,
      archived: t.archived,
      actions: t.actions,
    });
  }

  home(): Record<Bucket, Card[]> {
    const lanes: Record<Bucket, Card[]> = { needs_you: [], cue_on_it: [], waiting: [], taken_care_of: [] };
    for (const t of this.threads.values()) {
      const s = t.signals;
      const last = t.messages.at(-1)!;
      const bucket = this.bucket(t);
      const p = priorityOf({
        deadlineDays: s.deadline?.daysLeft,
        family: s.counterpart.family,
        conflict: s.sameDayEvents.some((e) => e.overlaps),
        intent: t.intent,
      });
      const running = t.actions.find((a) => a.status === "running");
      const done = [...t.actions].reverse().find((a) => a.status === "done");
      let note: string | undefined;
      if (bucket === "cue_on_it" && running) note = `${running.label}…`;
      else if (bucket === "waiting") note = `Waiting ${Math.floor(s.waitingDays ?? 0)} days on ${s.counterpart.name}`;
      else if (bucket === "taken_care_of") note = done?.outcome ?? (s.lastFromMe ? "You replied" : t.intent === "newsletter" ? "Filed: newsletter" : t.intent === "receipt" ? "Filed: receipt" : "Nothing to do");
      lanes[bucket].push({
        threadId: t.id,
        subject: t.subject.replace(/^(re|fwd?):\s*/i, ""),
        from: s.counterpart.name,
        account: this.accountLabel(t.accountId),
        summary: t.analysis.summary,
        when: last.sentAt,
        reason: bucket === "needs_you" ? p.reason : undefined,
        note,
        priority: p.score,
      });
    }
    lanes.needs_you.sort((a, b) => b.priority - a.priority || b.when.localeCompare(a.when));
    for (const k of ["cue_on_it", "waiting", "taken_care_of"] as const) lanes[k].sort((a, b) => b.when.localeCompare(a.when));
    return lanes;
  }

  thread(id: string, opts: { countView?: boolean } = {}) {
    const t = this.threads.get(id);
    if (!t) return null;
    if (opts.countView && !this.metrics.threadsOpened.has(id)) {
      this.metrics.threadsOpened.add(id);
      // Each context item from another app or inbox is a search the user didn't have to do.
      this.metrics.appSearchesSaved += t.signals.context.filter((c) => c.source?.accountId !== t.accountId).length;
    }
    return {
      id: t.id,
      subject: t.subject.replace(/^(re|fwd?):\s*/i, ""),
      account: this.accountLabel(t.accountId),
      bucket: this.bucket(t),
      intent: t.intent,
      intents: t.signals.intents,
      messages: t.messages.map((m) => ({
        id: m.id, from: m.from.name ?? m.from.email, fromMe: this.isMe(m.from.email), sentAt: m.sentAt, body: m.body, attachments: m.attachments,
      })),
      analysis: t.analysis,
      context: t.signals.context.map((c) => ({ ...c, sourceLabel: c.source ? this.accountLabel(c.source.accountId) : "" })),
      actions: t.actions.filter((a) => a.status !== "dismissed"),
    };
  }

  private accountLabel(accountId: string) {
    return this.opts.accounts.find((a) => a.id === accountId)?.label ?? accountId;
  }

  // -------------------------------------------------------------------------
  // Actions

  approve(actionId: string, edits: { body?: string } = {}): Action {
    const a = this.mustGet(actionId);
    if (a.status !== "proposed") throw new Error(`Action ${actionId} is ${a.status}`);
    if (edits.body !== undefined) a.params.body = edits.body;
    this.run(a, "you");
    return a;
  }

  dismiss(actionId: string): Action {
    const a = this.mustGet(actionId);
    if (a.status !== "proposed") throw new Error(`Action ${actionId} is ${a.status}`);
    a.status = "dismissed";
    // Dismissals are feedback: in a fuller system they become ranking/planning signals.
    this.log(a, "you", `Dismissed: ${a.label}`);
    return a;
  }

  undo(actionId: string): Action {
    const a = this.mustGet(actionId);
    if (a.status !== "done") throw new Error(`Only finished actions can be undone`);
    const t = this.threads.get(a.threadId)!;
    if (a.kind === "archive") t.archived = false;
    else if (a.kind === "add_to_calendar") this.graph.nodes.delete(String(a.params.eventId));
    else if (a.kind === "set_reminder") this.reminders.splice(this.reminders.findIndex((r) => r.actionId === a.id), 1);
    else throw new Error("Sent mail can't be unsent");
    a.status = "undone";
    this.log(a, "you", `Undid: ${a.outcome ?? a.label}`);
    return a;
  }

  setRule(id: string, enabled: boolean) {
    const rule = this.rules.find((r) => r.id === id);
    if (!rule) throw new Error(`No rule ${id}`);
    rule.enabled = enabled;
  }

  private run(a: Action, by: string) {
    a.status = "running";
    const finish = () => {
      if (a.status !== "running") return;
      a.outcome = this.execute(a);
      a.status = "done";
      this.log(a, by, a.outcome);
      const t = this.threads.get(a.threadId)!;
      if (a.kind === "send_reply" || a.kind === "nudge") {
        for (const other of t.actions) if (other.status === "proposed" && (other.kind === "send_reply" || other.kind === "nudge")) other.status = "dismissed";
        this.analyzeSync(t);
        if (this.brain !== this.heuristic) void this.brain.analyze(t.signals).then((x) => { t.analysis = x; this.replan(t); });
      }
    };
    const delay = this.opts.actionDelayMs ?? 0;
    if (delay > 0) setTimeout(finish, delay);
    else finish();
  }

  /**
   * Perform the action against the user's sources. In demo mode the "sources" are
   * in memory; a production executor calls Gmail/Calendar APIs (e.g. via Composio)
   * and writes the result back to the source inbox, so the change shows up everywhere.
   */
  private execute(a: Action): string {
    const t = this.threads.get(a.threadId)!;
    const tz = this.opts.tz;
    switch (a.kind) {
      case "archive":
        t.archived = true;
        return a.label.replace("File", "Filed");
      case "add_to_calendar": {
        const id = `evt_cue_${a.id}`;
        this.graph.upsertNode(id, "event", String(a.params.title), { start: a.params.start, end: a.params.end, createdBy: "cue" });
        a.params.eventId = id;
        return `Added “${a.params.title}” to your calendar (${formatLocal(String(a.params.start), tz, !a.params.allDay)})`;
      }
      case "set_reminder":
        this.reminders.push({ at: String(a.params.at), note: String(a.params.note), actionId: a.id });
        return `Reminder set for ${formatLocal(String(a.params.at), tz, false)}: ${a.params.note}`;
      case "send_reply":
      case "nudge": {
        const last = t.messages.at(-1)!;
        const me = this.opts.accounts.find((x) => x.id === t.accountId)?.address ?? this.opts.accounts[0].address;
        const to = this.isMe(last.from.email) ? last.to : [last.from];
        const attachments = ((a.params.attachments as { title: string }[] | undefined) ?? []).map((x) => x.title);
        t.messages = [
          ...t.messages,
          {
            id: `msg_cue_${a.id}`, threadId: t.id, from: { name: this.opts.userName, email: me }, to,
            subject: last.subject.startsWith("Re:") ? last.subject : `Re: ${last.subject}`,
            body: String(a.params.body), sentAt: this.now(), attachments, source: { ...last.source, sourceId: `sent_${a.id}` },
          },
        ];
        return `Sent to ${to.map((x) => x.name ?? x.email).join(", ")}${attachments.length ? ` with ${attachments.join(", ")}` : ""}`;
      }
    }
  }

  private log(a: Action, by: string, text: string) {
    this.audit.unshift({ at: this.now(), threadId: a.threadId, actionId: a.id, by, text });
  }

  private mustGet(id: string): Action {
    const a = this.actions.get(id);
    if (!a) throw new Error(`No action ${id}`);
    return a;
  }

  summary() {
    return {
      now: this.now(),
      user: this.opts.userName,
      accounts: this.opts.accounts,
      brain: this.brain.name,
      rules: this.rules.map(({ id, label, enabled }) => ({ id, label, enabled })),
      reminders: this.reminders,
      metrics: { appSearchesSaved: this.metrics.appSearchesSaved, threadsOpened: this.metrics.threadsOpened.size },
      audit: this.audit.slice(0, 50),
      graph: { nodes: this.graph.nodes.size, edges: this.graph.edges().length },
    };
  }
}

/** The sentence in `body` most similar to `query` — a quotable answer. */
function bestSentence(body: string, query: string, corpus: Corpus): string {
  const ss = sentences(body);
  return ss.reduce((best, s) => (corpus.similarity(query, s) > corpus.similarity(query, best) ? s : best), ss[0] ?? body);
}
