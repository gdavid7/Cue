// The generic path: ingest a record from *any* app without writing an adapter.
//
// Dedicated adapters (normalize.ts) exist only for the few sources Cue reasons
// about deeply — email, calendar, files. Everything else (the long tail of apps
// an integration layer like Composio can connect) goes through here:
//
//   1. Pull out a thin envelope every record has: who, when, title, text, link.
//      Field names differ per app, so we look for the common spellings, and a
//      per-app `hints` map can point at the right field when guessing fails.
//   2. Keep the original payload untouched in `raw`, so nothing is lost and a
//      richer extractor (an LLM, or Graphiti's episode ingestion) can read it later.
//
// This is the same pattern unified-API and enterprise-search products use: a
// small common model plus a passthrough of the raw data.

import type { Identity, Item, Provenance } from "../core/types.ts";

export interface FieldHints {
  title?: string;
  text?: string;
  at?: string;
  author?: string;
  people?: string;
  url?: string;
}

const CANDIDATES: Required<{ [K in keyof FieldHints]: string[] }> = {
  title: ["title", "name", "subject", "summary", "channel.name", "topic"],
  text: ["text", "body", "content", "plain_text", "description", "transcript", "snippet", "message"],
  at: ["ts", "created_at", "createdAt", "timestamp", "date", "start_time", "updated_at", "updatedAt", "last_edited_time"],
  author: ["user", "author", "from", "creator", "created_by", "createdBy", "owner", "sender"],
  people: ["participants", "attendees", "members", "assignees", "mentions", "to", "recipients"],
  url: ["permalink", "url", "web_url", "webUrl", "link", "html_url"],
};

export function fromRecord(
  app: string,
  type: string,
  record: Record<string, unknown>,
  source: Provenance,
  hints: FieldHints = {},
): Item {
  const pick = (field: keyof FieldHints) => {
    for (const path of hints[field] ? [hints[field]!] : CANDIDATES[field]) {
      const v = get(record, path);
      if (v !== undefined && v !== null && v !== "") return v;
    }
    return undefined;
  };

  const text = asText(pick("text"));
  const rawTitle = asText(pick("title"));
  const title = rawTitle ? (app === "slack" && !rawTitle.startsWith("#") ? `#${rawTitle}` : rawTitle) : text.slice(0, 60);
  const people = pick("people");

  return {
    id: `item_${app}_${source.sourceId}`,
    app,
    type,
    title,
    text,
    at: asTime(pick("at")) ?? new Date(0).toISOString(),
    url: asText(pick("url")) || undefined,
    author: asIdentity(pick("author")),
    people: Array.isArray(people) ? people.map(asIdentity).filter((p): p is Identity => !!p) : [],
    raw: record,
    source,
  };
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((o, k) => (o && typeof o === "object" ? (o as Record<string, unknown>)[k] : undefined), obj);
}

function asText(v: unknown): string {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(" ");
  if (v && typeof v === "object") return asText((v as Record<string, unknown>).plain_text ?? (v as Record<string, unknown>).text ?? (v as Record<string, unknown>).name);
  return "";
}

/** Times come as ISO strings, epoch seconds ("1760290800.0001" in Slack), or epoch ms. */
function asTime(v: unknown): string | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isNaN(n) && n > 0) return new Date(n < 1e11 ? n * 1000 : n).toISOString();
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

/** People appear as "a@b.com", "Name <a@b.com>", or objects in many shapes. */
function asIdentity(v: unknown): Identity | undefined {
  if (!v) return undefined;
  if (typeof v === "string") {
    const m = v.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
    if (m) return { name: m[1] || undefined, email: m[2].toLowerCase() };
    return v.includes("@") ? { email: v.toLowerCase() } : { name: v };
  }
  if (typeof v !== "object") return undefined;
  const o = v as Record<string, any>;
  const name = o.real_name ?? o.display_name ?? o.displayName ?? o.name ?? o.profile?.real_name ?? o.emailAddress?.name;
  const email = o.email ?? o.profile?.email ?? o.person?.email ?? o.emailAddress?.address;
  if (!name && !email) return undefined;
  return { name: name || undefined, email: email ? String(email).toLowerCase() : undefined };
}
