// Step 3: turn normalized source objects into a knowledge graph.
//
//   person ──sent──▶ message ──in_thread──▶ thread ──about──▶ topic
//   person ──works_at──▶ org          person ──attended──▶ event
//   person ──owns──▶ doc ──shared_with──▶ person      doc ──states──▶ fact
//
// Every edge carries a timestamp, a confidence, and the source it came from.

import type { CalendarEvent, Doc, Message, Provenance, SourceObject } from "../core/types.ts";
import { EntityResolver, orgFromEmail } from "../resolve/entities.ts";
import { tokenize } from "../retrieve/text.ts";
import { extractFacts } from "./facts.ts";
import { TemporalGraph } from "./graph.ts";

export interface TopicSeed {
  id: string;
  label: string;
  keywords: string[];
}

export interface BuildResult {
  graph: TemporalGraph;
  resolver: EntityResolver;
  messages: Map<string, Message>;
  events: Map<string, CalendarEvent>;
  docs: Map<string, Doc>;
}

export function buildGraph(objects: SourceObject[], resolver: EntityResolver, topics: TopicSeed[]): BuildResult {
  const graph = new TemporalGraph();
  const messages = new Map<string, Message>();
  const events = new Map<string, CalendarEvent>();
  const docs = new Map<string, Doc>();

  for (const t of topics) graph.upsertNode(t.id, "topic", t.label, { keywords: t.keywords });

  // Emails first: they carry the richest identity evidence (full addresses,
  // signatures), which later helps resolve sparse calendar attendees.
  const order = { message: 0, doc: 1, event: 2 } as const;
  const sorted = [...objects].sort((a, b) => order[a.kind] - order[b.kind] || timeOf(a).localeCompare(timeOf(b)));

  const personNode = (personId: string, source: Provenance) => {
    const p = resolver.people.get(personId)!;
    graph.upsertNode(personId, "person", p.name, { emails: [...p.emails], automated: p.automated }, source);
    for (const email of p.emails) {
      const org = orgFromEmail(email);
      if (!org) continue;
      graph.upsertNode(`org_${org}`, "org", org);
      graph.addEdge({ type: "works_at", from: personId, to: `org_${org}`, validFrom: "1970-01-01T00:00:00Z", confidence: 1, source });
    }
  };

  const linkTopics = (nodeId: string, text: string, at: string, source: Provenance) => {
    const tokens = new Set(tokenize(text));
    for (const t of topics) {
      const hits = t.keywords.filter((k) => tokens.has(k)).length;
      if (hits >= 2) {
        graph.addEdge({ type: "about", from: nodeId, to: t.id, validFrom: at, confidence: Math.min(1, hits / 4), source });
      }
    }
  };

  for (const obj of sorted) {
    if (obj.kind === "message") {
      const m = obj.value;
      messages.set(m.id, m);
      const text = `${m.subject} ${m.body}`;
      graph.upsertNode(m.threadId, "thread", m.subject.replace(/^(re|fwd?):\s*/i, ""), { accountId: m.source.accountId }, m.source);
      graph.upsertNode(m.id, "message", m.subject, { body: m.body, sentAt: m.sentAt, threadId: m.threadId }, m.source);
      graph.addEdge({ type: "in_thread", from: m.id, to: m.threadId, validFrom: m.sentAt, confidence: 1, source: m.source });

      const sender = resolver.resolve(m.from, text);
      personNode(sender.personId, m.source);
      graph.addEdge({ type: "sent", from: sender.personId, to: m.id, validFrom: m.sentAt, confidence: sender.confidence, source: m.source });
      for (const r of m.to) {
        const res = resolver.resolve(r, text);
        personNode(res.personId, m.source);
        graph.addEdge({ type: "received", from: m.id, to: res.personId, validFrom: m.sentAt, confidence: res.confidence, source: m.source });
      }
      linkTopics(m.id, text, m.sentAt, m.source);
      linkTopics(m.threadId, text, m.sentAt, m.source);
      addFacts(graph, m.id, text, m.sentAt, m.source);
    } else if (obj.kind === "event") {
      const e = obj.value;
      events.set(e.id, e);
      const text = `${e.title} ${e.location ?? ""} ${e.notes ?? ""}`;
      graph.upsertNode(e.id, "event", e.title, { start: e.start, end: e.end, location: e.location, notes: e.notes }, e.source);
      for (const a of e.attendees) {
        const res = resolver.resolve(a, text);
        personNode(res.personId, e.source);
        graph.addEdge({ type: "attended", from: res.personId, to: e.id, validFrom: e.start, confidence: res.confidence, source: e.source });
      }
      linkTopics(e.id, text, e.start, e.source);
    } else {
      const d = obj.value;
      docs.set(d.id, d);
      const text = `${d.title} ${d.text}`;
      graph.upsertNode(d.id, "doc", d.title, { text: d.text, modifiedAt: d.modifiedAt, mimeType: d.mimeType }, d.source);
      const owner = resolver.resolve(d.owner, text);
      personNode(owner.personId, d.source);
      graph.addEdge({ type: "owns", from: owner.personId, to: d.id, validFrom: d.modifiedAt, confidence: owner.confidence, source: d.source });
      for (const s of d.sharedWith) {
        const res = resolver.resolve(s, text);
        personNode(res.personId, d.source);
        graph.addEdge({ type: "shared_with", from: d.id, to: res.personId, validFrom: d.modifiedAt, confidence: res.confidence, source: d.source });
      }
      linkTopics(d.id, text, d.modifiedAt, d.source);
      addFacts(graph, d.id, text, d.modifiedAt, d.source);
    }
  }

  supersedeFacts(graph);
  return { graph, resolver, messages, events, docs };
}

function addFacts(graph: TemporalGraph, nodeId: string, text: string, at: string, source: Provenance) {
  extractFacts(text).forEach((f, i) => {
    const factId = `fact_${nodeId}_${i}`;
    graph.upsertNode(factId, "fact", f.text, { key: f.key, value: f.value, proposed: f.proposed, sourceNode: nodeId }, source);
    graph.addEdge({ type: "states", from: nodeId, to: factId, validFrom: f.validFrom ?? at, validTo: f.validTo, confidence: 1, source });
  });
}

/**
 * When two *agreed* facts share a key, the older one stops being current the
 * moment the newer one appears. (Proposed values — offers — don't supersede.)
 */
function supersedeFacts(graph: TemporalGraph) {
  const byKey = new Map<string, { edgeId: string; validFrom: string }[]>();
  for (const e of graph.edges()) {
    if (e.type !== "states") continue;
    const fact = graph.nodes.get(e.to)!;
    if (fact.props.proposed) continue;
    const key = String(fact.props.key);
    byKey.set(key, [...(byKey.get(key) ?? []), { edgeId: e.id, validFrom: e.validFrom }]);
  }
  for (const list of byKey.values()) {
    list.sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    for (let i = 0; i < list.length - 1; i++) graph.invalidate(list[i].edgeId, list[i + 1].validFrom);
  }
}

function timeOf(o: SourceObject): string {
  return o.kind === "message" ? o.value.sentAt : o.kind === "event" ? o.value.start : o.value.modifiedAt;
}
