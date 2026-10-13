// The shared event model.
//
// Every connected source (Gmail, Outlook, Google Calendar, Drive, ...) speaks its
// own dialect. The ingestion layer translates each one into these few shapes so
// the rest of Cue never has to care where a fact came from — only that it can
// cite it.

export type Provider = "gmail" | "outlook" | "gcal" | "gdrive";

/** Where a fact came from. Every node and edge carries one so answers can cite it. */
export interface Provenance {
  provider: Provider;
  sourceId: string;
  accountId: string;
}

export interface Account {
  id: string;
  provider: Provider;
  address: string;
  label: string;
}

/** A raw identity as seen by one source, before entity resolution merges it. */
export interface Identity {
  name?: string;
  email?: string;
}

export interface Message {
  id: string;
  threadId: string;
  from: Identity;
  to: Identity[];
  subject: string;
  body: string;
  sentAt: string; // ISO-8601
  attachments: string[];
  source: Provenance;
}

export interface Thread {
  id: string;
  subject: string;
  messageIds: string[];
  accountId: string;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  location?: string;
  attendees: Identity[];
  notes?: string;
  source: Provenance;
}

export interface Doc {
  id: string;
  title: string;
  mimeType: string;
  modifiedAt: string;
  owner: Identity;
  sharedWith: Identity[];
  text: string; // extracted text used for retrieval
  source: Provenance;
}

export type SourceObject =
  | { kind: "message"; value: Message }
  | { kind: "event"; value: CalendarEvent }
  | { kind: "doc"; value: Doc };

// ---------------------------------------------------------------------------
// Knowledge graph shapes

export type NodeKind =
  | "person"
  | "org"
  | "topic"
  | "thread"
  | "message"
  | "event"
  | "doc"
  | "fact";

export type EdgeType =
  | "sent"
  | "received"
  | "attended"
  | "owns"
  | "shared_with"
  | "works_at"
  | "in_thread"
  | "about"
  | "mentions"
  | "states"
  | "related_to";

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  props: Record<string, unknown>;
  sources: Provenance[];
}

export interface GraphEdge {
  id: string;
  type: EdgeType;
  from: string;
  to: string;
  /** When this relationship became true (e.g. an email's send time). */
  validFrom: string;
  /** When it stopped being true. Undefined = still true as far as we know. */
  validTo?: string;
  /** 0..1. Deterministic joins get 1.0; fuzzy matches get less. */
  confidence: number;
  source?: Provenance;
}

// ---------------------------------------------------------------------------
// What the product layer produces

export type Intent =
  | "scheduling"
  | "document_request"
  | "decision"
  | "question"
  | "bill"
  | "receipt"
  | "newsletter"
  | "fyi";

export type Bucket = "needs_you" | "cue_on_it" | "waiting" | "taken_care_of";

export type Risk = "low" | "medium" | "high";

export type ActionKind = "send_reply" | "add_to_calendar" | "set_reminder" | "archive" | "nudge";

export type ActionStatus = "proposed" | "running" | "done" | "dismissed" | "undone";

export interface Action {
  id: string;
  threadId: string;
  kind: ActionKind;
  label: string;
  risk: Risk;
  params: Record<string, unknown>;
  status: ActionStatus;
  /** Set when an autonomy rule (not the user) approved it. */
  autoRule?: string;
  /** What happened, in plain words, once it ran. */
  outcome?: string;
}

export interface ReplyOption {
  label: string; // e.g. "Accept renewal"
  body: string;
}

/** What the "brain" (LLM or offline heuristics) says about a thread. */
export interface Analysis {
  summary: string;
  whatMatters: string[];
  replies: ReplyOption[];
  intent?: Intent; // an LLM may override the rule-based intent
  by: "heuristic" | "claude";
}

export interface ContextItem {
  nodeId: string;
  kind: NodeKind;
  title: string;
  snippet: string;
  when?: string;
  score: number;
  /** Human-readable path through the graph, e.g. ["Coach Dana", "Maya's soccer", "Medical form"]. */
  path: string[];
  confidence: number;
  stale: boolean;
  source?: Provenance;
}
