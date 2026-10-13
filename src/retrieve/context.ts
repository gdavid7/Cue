// Step 4b: intent-aware traversal + reranking — the "magic moment".
//
// Key principle from the brief: don't vector-search the whole workspace. Instead,
//   1. start from the people, thread, and topics in *this* email,
//   2. walk the graph outward a few hops (structure narrows the search space),
//   3. only then score the candidates with semantic similarity, recency, path
//      strength, and how useful that kind of item is for this intent,
//   4. return the top 2-4 with the path that found them (provenance).

import type { ContextItem, EdgeType, GraphNode, Intent, NodeKind } from "../core/types.ts";
import { daysBetween, formatLocal, localDate } from "../core/time.ts";
import type { TemporalGraph } from "../graph/graph.ts";
import { SELF_ID } from "../resolve/entities.ts";
import type { Corpus } from "./text.ts";

export interface RetrievalInput {
  graph: TemporalGraph;
  corpus: Corpus;
  threadId: string;
  query: string;
  intents: Intent[];
  dates: string[]; // local YYYY-MM-DD dates mentioned in the email
  now: string;
  tz: string;
  k?: number;
}

const CANDIDATE_KINDS: NodeKind[] = ["doc", "event", "message", "item"];
const WALKABLE: EdgeType[] = ["sent", "received", "attended", "owns", "authored", "mentions", "shared_with", "works_at", "in_thread", "about"];
const MAX_HOPS = 3;

/** How useful each kind of item tends to be, per intent (0..1). */
const KIND_PRIOR: Partial<Record<Intent, Partial<Record<NodeKind, number>>>> = {
  scheduling: { event: 1, item: 0.7, message: 0.5, doc: 0.2 },
  document_request: { doc: 1, message: 0.4, item: 0.4, event: 0.2 },
  decision: { doc: 1, item: 0.8, message: 0.7, event: 0.3 },
  question: { message: 0.8, item: 0.7, event: 0.7, doc: 0.6 },
  bill: { message: 0.6, doc: 0.4, item: 0.3, event: 0.2 },
};

interface Reached {
  node: GraphNode;
  path: string[]; // node ids, anchor first
  confidence: number; // product of edge confidences along the path
  hops: number;
  stale: boolean;
}

export function retrieveContext(input: RetrievalInput): ContextItem[] {
  const { graph, threadId, now, k = 4 } = input;
  const threadMessages = new Set(graph.neighbors(threadId, { types: ["in_thread"] }).map((n) => n.node.id));

  // --- 1. Anchors: the thread itself and everyone on it (except the user, who is
  // connected to *everything* and would make every node look relevant).
  const anchors = new Set<string>([threadId]);
  for (const msgId of threadMessages) {
    for (const { node } of graph.neighbors(msgId, { types: ["sent", "received"] })) {
      if (node.id !== SELF_ID) anchors.add(node.id);
    }
  }

  // --- 2. Breadth-first walk, keeping the strongest path to each node.
  const best = new Map<string, Reached>();
  let frontier: Reached[] = [...anchors].map((id) => ({ node: graph.nodes.get(id)!, path: [id], confidence: 1, hops: 0, stale: false }));
  for (const r of frontier) best.set(r.node.id, r);

  for (let hop = 1; hop <= MAX_HOPS; hop++) {
    const next: Reached[] = [];
    for (const r of frontier) {
      if (r.node.id === SELF_ID) continue;
      for (const { edge, node } of graph.neighbors(r.node.id, { types: WALKABLE })) {
        if (node.id === SELF_ID) continue;
        const reached: Reached = {
          node,
          path: [...r.path, node.id],
          confidence: r.confidence * edge.confidence,
          hops: hop,
          stale: r.stale || (!!edge.validTo && edge.validTo < now),
        };
        const prev = best.get(node.id);
        if (!prev || reached.confidence / reached.hops > prev.confidence / Math.max(prev.hops, 1)) {
          best.set(node.id, reached);
          next.push(reached);
        }
      }
    }
    frontier = next;
  }

  // --- 3. Time is a dimension too: for scheduling, the user's calendar on the
  // mentioned dates is relevant even if nobody on the thread is invited.
  if (input.intents.includes("scheduling") || input.intents.includes("question")) {
    for (const ev of graph.byKind("event")) {
      if (input.dates.includes(localDate(String(ev.props.start), input.tz)) && !best.has(ev.id)) {
        best.set(ev.id, { node: ev, path: ["calendar", ev.id], confidence: 1, hops: 1, stale: false });
      }
    }
  }

  // --- 4. Score candidates.
  const scored: ContextItem[] = [];
  for (const r of best.values()) {
    if (!CANDIDATE_KINDS.includes(r.node.kind) || threadMessages.has(r.node.id)) continue;
    const text = textOf(r.node);
    const sem = input.corpus.similarity(input.query, text);
    const when = timeOf(r.node);
    const age = when ? Math.abs(daysBetween(when, now)) : 365;
    const recency = Math.exp(-age / 30);
    const structure = r.confidence / r.hops;
    const prior = Math.max(...input.intents.map((i) => KIND_PRIOR[i]?.[r.node.kind] ?? 0.3));
    const dateMatch = r.node.kind === "event" && input.dates.includes(localDate(String(r.node.props.start), input.tz)) ? 1 : 0;
    const score = 0.4 * sem + 0.15 * recency + 0.2 * structure + 0.15 * prior + 0.25 * dateMatch;

    scored.push({
      nodeId: r.node.id,
      kind: r.node.kind,
      title: titleOf(r.node, input.tz),
      snippet: snippetOf(r.node),
      when,
      score: Math.round(score * 1000) / 1000,
      path: r.path.map((id) => (id === "calendar" ? "Your calendar" : graph.nodes.get(id)?.label ?? id)),
      confidence: Math.round(r.confidence * 100) / 100,
      stale: r.stale,
      source: r.node.sources[0],
    });
  }

  scored.sort((a, b) => b.score - a.score);
  // Keep the top k, but drop anything much weaker than the best hit: showing the
  // user two great items beats showing them two great items and two weak ones.
  const top = scored[0]?.score ?? 0;
  const picked = scored.filter((c) => c.score >= Math.max(0.2, top * 0.5)).slice(0, k);

  // Coverage: an email can ask for two things ("can she make it?" + "send the
  // form"). Make sure the best item of each intent's key kind is present.
  for (const intent of input.intents) {
    const key = Object.entries(KIND_PRIOR[intent] ?? {}).find(([, w]) => w === 1)?.[0];
    if (!key || picked.some((c) => c.kind === key)) continue;
    const best = scored.find((c) => c.kind === key && c.score >= 0.2);
    if (best) picked.splice(picked.length >= k ? k - 1 : picked.length, 1, best);
  }
  return picked.sort((a, b) => b.score - a.score);
}

function textOf(n: GraphNode): string {
  if (n.kind === "doc") return `${n.label} ${n.props.text ?? ""}`;
  if (n.kind === "message") return `${n.label} ${n.props.body ?? ""}`;
  if (n.kind === "item") return `${n.label} ${n.props.text ?? ""}`;
  if (n.kind === "event") return `${n.label} ${n.props.location ?? ""} ${n.props.notes ?? ""}`;
  return n.label;
}

function timeOf(n: GraphNode): string | undefined {
  return (n.props.sentAt ?? n.props.start ?? n.props.modifiedAt ?? n.props.at) as string | undefined;
}

function titleOf(n: GraphNode, tz: string): string {
  if (n.kind === "event") return `${n.label} · ${formatLocal(String(n.props.start), tz)}`;
  return n.label;
}

function snippetOf(n: GraphNode): string {
  const raw =
    n.kind === "doc" || n.kind === "item" ? n.props.text : n.kind === "message" ? n.props.body : [n.props.location, n.props.notes].filter(Boolean).join(" · ");
  const s = String(raw ?? "");
  return s.length > 180 ? s.slice(0, 177) + "…" : s;
}
