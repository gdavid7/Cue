// A small in-memory *temporal* knowledge graph.
//
// "Temporal" means every edge records when it became true (validFrom) and, once
// superseded, when it stopped being true (validTo). Old facts are never deleted —
// they are closed — so Cue can answer "what was true then?" and can flag stale
// information instead of silently treating it as current.
//
// The interface mirrors what we'd use from Graphiti (episodes in, entities and
// time-bounded relationships out), so a Graphiti/Neo4j backend can replace this
// class without touching retrieval code.

import type { EdgeType, GraphEdge, GraphNode, NodeKind, Provenance } from "../core/types.ts";

export interface Neighbor {
  edge: GraphEdge;
  node: GraphNode;
}

export class TemporalGraph {
  nodes = new Map<string, GraphNode>();
  private out = new Map<string, GraphEdge[]>();
  private in = new Map<string, GraphEdge[]>();
  private edgeSeq = 0;

  upsertNode(id: string, kind: NodeKind, label: string, props: Record<string, unknown> = {}, source?: Provenance): GraphNode {
    let node = this.nodes.get(id);
    if (!node) {
      node = { id, kind, label, props: {}, sources: [] };
      this.nodes.set(id, node);
    }
    Object.assign(node.props, props);
    if (source && !node.sources.some((s) => s.provider === source.provider && s.sourceId === source.sourceId)) {
      node.sources.push(source);
    }
    return node;
  }

  addEdge(e: Omit<GraphEdge, "id">): GraphEdge {
    // Re-asserting an identical open edge just keeps the higher confidence.
    const existing = (this.out.get(e.from) ?? []).find((x) => x.type === e.type && x.to === e.to && !x.validTo);
    if (existing) {
      existing.confidence = Math.max(existing.confidence, e.confidence);
      return existing;
    }
    const edge: GraphEdge = { id: `e${++this.edgeSeq}`, ...e };
    push(this.out, edge.from, edge);
    push(this.in, edge.to, edge);
    return edge;
  }

  /** Mark a relationship as no longer true from `at` onward (it is kept for history). */
  invalidate(edgeId: string, at: string) {
    for (const list of this.out.values()) {
      const e = list.find((x) => x.id === edgeId);
      if (e) e.validTo = at;
    }
  }

  /** Edges touching `id` in either direction, optionally only those true at time `at`. */
  neighbors(id: string, opts: { at?: string; types?: EdgeType[] } = {}): Neighbor[] {
    const result: Neighbor[] = [];
    const visit = (edges: GraphEdge[] | undefined, other: (e: GraphEdge) => string) => {
      for (const edge of edges ?? []) {
        if (opts.types && !opts.types.includes(edge.type)) continue;
        if (opts.at && !isValidAt(edge, opts.at)) continue;
        const node = this.nodes.get(other(edge));
        if (node) result.push({ edge, node });
      }
    };
    visit(this.out.get(id), (e) => e.to);
    visit(this.in.get(id), (e) => e.from);
    return result;
  }

  edges(): GraphEdge[] {
    return [...this.out.values()].flat();
  }

  byKind(kind: NodeKind): GraphNode[] {
    return [...this.nodes.values()].filter((n) => n.kind === kind);
  }
}

export function isValidAt(edge: GraphEdge, at: string): boolean {
  return edge.validFrom <= at && (!edge.validTo || at < edge.validTo);
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V) {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}
