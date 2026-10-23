import { normalizeInternetMessageId } from "@inboxzero/mail-core/messages";
import type { MailPredicate } from "@inboxzero/mail-core/queries";
import { contactNameMessages, splitNameWords } from "./contact-name-search";
import type { SqlValue } from "./driver";
import { searchMatchQuery } from "./search-text";

export function compilePredicate(
  predicate: MailPredicate,
  search: SearchSupport,
  alias = "e",
): { sql: string; bindings: SqlValue[] } {
  switch (predicate.kind) {
    case "all": {
      if (predicate.predicates.length === 0)
        return { sql: "1=1", bindings: [] };
      const parts = predicate.predicates.map((child) =>
        compilePredicate(child, search, alias),
      );
      return {
        sql: `(${parts.map((part) => part.sql).join(" AND ")})`,
        bindings: parts.flatMap((part) => part.bindings),
      };
    }
    case "any": {
      if (predicate.predicates.length === 0)
        return { sql: "0=1", bindings: [] };
      const parts = predicate.predicates.map((child) =>
        compilePredicate(child, search, alias),
      );
      return {
        sql: `(${parts.map((part) => part.sql).join(" OR ")})`,
        bindings: parts.flatMap((part) => part.bindings),
      };
    }
    case "not": {
      // Leaving a person out of the results stays a matter of their text.
      const inner = compilePredicate(
        predicate.predicate,
        { ...search, contactNames: undefined },
        alias,
      );
      return { sql: `(NOT ${inner.sql})`, bindings: inner.bindings };
    }
    case "role": {
      const column = {
        inbox: "in_inbox",
        sent: "in_sent",
        draft: "in_draft",
        trash: "in_trash",
        spam: "in_spam",
      }[predicate.role];
      return { sql: `${alias}.${column} = 1`, bindings: [] };
    }
    case "mailbox":
      return compileMailboxPredicate(predicate.mailbox, alias);
    case "read":
      return { sql: `${alias}.read = ?`, bindings: [predicate.value ? 1 : 0] };
    case "starred":
      return {
        sql: `${alias}.starred = ?`,
        bindings: [predicate.value ? 1 : 0],
      };
    case "inbox_section":
      return {
        sql: `${alias}.inbox_section = ?`,
        bindings: [predicate.section],
      };
    case "membership": {
      const accountSql = predicate.accountId
        ? `${alias}.account_id = ? AND `
        : "";
      const accountBindings: SqlValue[] = predicate.accountId
        ? [predicate.accountId]
        : [];
      if (predicate.membership === "folder") {
        return {
          sql: `(${accountSql}${alias}.folder_id = ?)`,
          bindings: [...accountBindings, predicate.id],
        };
      }
      if (predicate.membership === "label") {
        return {
          sql: `(${accountSql}EXISTS (SELECT 1 FROM json_each(${alias}.label_ids_json) WHERE value = ?))`,
          bindings: [...accountBindings, predicate.id],
        };
      }
      return {
        sql: `(${accountSql}EXISTS (SELECT 1 FROM json_each(${alias}.category_ids_json) WHERE value = ?))`,
        bindings: [...accountBindings, predicate.id],
      };
    }
    case "address": {
      const column = {
        from: `${alias}.from_address`,
        to: `${alias}.to_json`,
        cc: `${alias}.cc_json`,
        bcc: `${alias}.bcc_json`,
      }[predicate.field];
      // Typed text, so `_` and `%` are matched as themselves.
      const contains = `%${escapeLike(predicate.value.toLowerCase())}%`;
      if (predicate.field === "from" && predicate.match === "address") {
        return {
          sql: `(LOWER(${column}) = LOWER(?) OR LOWER(${column}) LIKE ? ESCAPE '\\')`,
          bindings: [predicate.value, contains],
        };
      }
      return {
        sql: `LOWER(${column}) LIKE ? ESCAPE '\\'`,
        bindings: [contains],
      };
    }
    case "received": {
      const parts: string[] = [];
      const bindings: SqlValue[] = [];
      if (predicate.afterMs !== null) {
        parts.push(`${alias}.received_at_ms >= ?`);
        bindings.push(predicate.afterMs);
      }
      if (predicate.beforeMs !== null) {
        parts.push(`${alias}.received_at_ms < ?`);
        bindings.push(predicate.beforeMs);
      }
      return {
        sql: parts.length ? `(${parts.join(" AND ")})` : "1=1",
        bindings,
      };
    }
    case "has_attachment":
      return {
        sql: `${alias}.has_attachments = ?`,
        bindings: [predicate.value ? 1 : 0],
      };
    case "message": {
      if (predicate.ids.length === 0) return { sql: "0=1", bindings: [] };
      const ids = `${alias}.message_id IN (${predicate.ids.map(() => "?").join(",")})`;
      if (!predicate.accountId) return { sql: ids, bindings: predicate.ids };
      return {
        sql: `(${alias}.account_id = ? AND ${ids})`,
        bindings: [predicate.accountId, ...predicate.ids],
      };
    }
    case "conversation": {
      if (predicate.ids.length === 0) return { sql: "0=1", bindings: [] };
      const ids = `${alias}.conversation_id IN (${predicate.ids.map(() => "?").join(",")})`;
      if (!predicate.accountId) return { sql: ids, bindings: predicate.ids };
      return {
        sql: `(${alias}.account_id = ? AND ${ids})`,
        bindings: [predicate.accountId, ...predicate.ids],
      };
    }
    // Matched on each message's stored key, normalised at every write by the
    // same rule, so ids differing only in case or angle brackets agree.
    case "internet_message_id": {
      const keys = [
        ...new Set(
          predicate.ids.flatMap((id) => normalizeInternetMessageId(id) ?? []),
        ),
      ];
      if (keys.length === 0) return { sql: "0=1", bindings: [] };
      const ids = `${alias}.message_key IN (${keys.map(() => "?").join(",")})`;
      if (!predicate.accountId) return { sql: ids, bindings: keys };
      return {
        sql: `(${alias}.account_id = ? AND ${ids})`,
        bindings: [predicate.accountId, ...keys],
      };
    }
    case "text":
      return compileTextPredicate(predicate, search, alias);
    // The engine adds the provider's matches before a view reads; anything
    // else answers from the store alone.
    case "search": {
      const local = compilePredicate(predicate.local, search, alias);
      if (!predicate.accountIds) return local;
      return {
        sql: `(${alias}.account_id IN (${predicate.accountIds.map(() => "?").join(",")}) AND ${local.sql})`,
        bindings: [...predicate.accountIds, ...local.bindings],
      };
    }
    case "account":
      if (!predicate.ids.length) return { sql: "0=1", bindings: [] };
      return {
        sql: `${alias}.account_id IN (${predicate.ids.map(() => "?").join(",")})`,
        bindings: predicate.ids,
      };
    default: {
      const exhaustive: never = predicate;
      return exhaustive;
    }
  }
}

// `complete` means every message has a search row, so the index alone answers
// text predicates. `contactNames` are the typed words that also match people
// by name (see contact-name-search.ts).
export type SearchSupport = {
  fts5: boolean;
  complete: boolean;
  contactNames?: { words: ReadonlySet<string>; accountIds: string[] };
};

// When the index is complete and the predicate requires a text match, the
// query starts from the index hits and joins each to its message, so a search
// costs in proportion to its matches rather than to the mailbox. Resolves the
// source to select from and the rest of the predicate to filter it by.
export function searchDrivenSource(
  predicate: MailPredicate,
  search: SearchSupport,
): { from: string; bindings: SqlValue[]; rest: MailPredicate } | null {
  if (!search.fts5 || !search.complete) return null;
  const clauses = topLevelClauses(predicate);
  for (const [index, clause] of clauses.entries()) {
    const driven = drivenClause(clause, search);
    if (!driven) continue;
    const others = clauses.filter((_clause, position) => position !== index);
    const join = `CROSS JOIN effective_messages e
            ON e.account_id = hit.account_id AND e.message_id = hit.message_id`;
    if (!driven.matched) {
      return {
        from: `(${driven.hits.sql}) hit ${join}`,
        bindings: driven.hits.bindings,
        rest: { kind: "all", predicates: [...others, ...driven.rest] },
      };
    }
    // A typed search with the provider's matches: the index hits and those
    // messages. Either kind of row still has to pass the rest of the search,
    // which an index hit already matches the text of, or the provider's side.
    const lookups = driven.matched.messages.map((messages) => {
      const ids = messages.ids.map(() => "?").join(",");
      return messages.accountId
        ? {
            sql: `SELECT m.account_id, m.message_id FROM effective_messages m
              WHERE m.account_id = ? AND m.message_id IN (${ids})`,
            bindings: [messages.accountId, ...messages.ids],
          }
        : {
            sql: `SELECT m.account_id, m.message_id
              FROM accounts a CROSS JOIN effective_messages m
                ON m.account_id = a.account_id AND m.message_id IN (${ids})`,
            bindings: messages.ids,
          };
    });
    return {
      from: `(${[driven.hits.sql, ...lookups.map((lookup) => lookup.sql)].join(
        "\n            UNION\n            ",
      )}) hit ${join}`,
      bindings: [
        ...driven.hits.bindings,
        ...lookups.flatMap((lookup) => lookup.bindings),
      ],
      rest: {
        kind: "all",
        predicates: [
          ...others,
          {
            kind: "any",
            predicates: [
              { kind: "all", predicates: driven.rest },
              driven.matched.filter,
            ],
          },
        ],
      },
    };
  }
  return null;
}

type DrivenClause = {
  /** The (account_id, message_id) rows the query starts from. */
  hits: { sql: string; bindings: SqlValue[] };
  rest: MailPredicate[];
  /** The provider's matches, and the condition they are listed under. */
  matched?: {
    messages: Array<Extract<MailPredicate, { kind: "message" }>>;
    filter: MailPredicate;
  };
};

// A clause the index can start from: a text match, alone or with conditions
// beside it, optionally or one of the provider's matches.
function drivenClause(
  clause: MailPredicate,
  search: SearchSupport,
): DrivenClause | null {
  if (clause.kind === "text") return drivenText(clause, search, []);
  if (clause.kind === "all") {
    const parts = clause.predicates;
    for (const [index, part] of parts.entries()) {
      if (part.kind !== "text") continue;
      const driven = drivenText(
        part,
        search,
        parts.filter((_part, position) => position !== index),
      );
      if (driven) return driven;
    }
    return null;
  }
  if (clause.kind !== "any" || clause.predicates.length !== 2) return null;
  for (const [index, part] of clause.predicates.entries()) {
    const messages = listedMessages(part);
    if (!messages?.length) continue;
    const other = clause.predicates[1 - index];
    if (other.kind === "any") return null;
    const driven = drivenClause(other, search);
    return driven ? { ...driven, matched: { messages, filter: part } } : null;
  }
  return null;
}

// A name's rows are its text matches and its people's mail, and they are
// intersected with the other words' text matches, so a common word beside a
// name never lists most of the mailbox.
function drivenText(
  text: Extract<MailPredicate, { kind: "text" }>,
  search: SearchSupport,
  rest: MailPredicate[],
): DrivenClause | null {
  const { names, others } = splitNameWords(text, search);
  const parts: Array<{ sql: string; bindings: SqlValue[] }> = [];
  if (others.length || !names.length) {
    const match = textMatchQuery(
      names.length ? { ...text, value: others.join(" ") } : text,
    );
    if (!match) return null;
    parts.push(indexHits(match));
  }
  for (const name of names) {
    const match = textMatchQuery({ ...text, value: name });
    if (!match) return null;
    const textHits = indexHits(match);
    const people = contactNameMessages(name, search);
    parts.push({
      sql: `SELECT account_id, message_id FROM (${textHits.sql}
            UNION
            ${people.sql})`,
      bindings: [...textHits.bindings, ...people.bindings],
    });
  }
  if (parts.length === 1) return { hits: parts[0], rest };
  return {
    hits: {
      sql: `SELECT account_id, message_id FROM (${parts
        .map((part) => part.sql)
        .join("\n            INTERSECT\n            ")})`,
      bindings: parts.flatMap((part) => part.bindings),
    },
    rest,
  };
}

function indexHits(match: string) {
  return {
    sql: `SELECT k.account_id, k.message_id
            FROM message_fts CROSS JOIN message_fts_keys k ON k.fts_rowid = message_fts.rowid
            WHERE message_fts MATCH ?`,
    bindings: [match] as SqlValue[],
  };
}

// The messages a condition is limited to: a message list, alternatives of
// them, or either alongside other conditions.
function listedMessages(
  predicate: MailPredicate,
): Array<Extract<MailPredicate, { kind: "message" }>> | null {
  if (predicate.kind === "message") return [predicate];
  if (predicate.kind === "any") {
    const lists = predicate.predicates.map(listedMessages);
    return lists.every((list) => list !== null) ? lists.flat() : null;
  }
  if (predicate.kind === "all") {
    for (const part of predicate.predicates) {
      const list = listedMessages(part);
      if (list) return list;
    }
  }
  return null;
}

// Indexed messages are matched through message_fts. A message without a
// search row (metadata only, or waiting in the index backlog) is matched by
// substring over its small columns instead, so results are not silently
// missing while the backlog catches up. Stored bodies are compressed, so a
// body only becomes searchable once it is indexed.
function compileTextPredicate(
  predicate: Extract<MailPredicate, { kind: "text" }>,
  search: SearchSupport,
  alias: string,
): { sql: string; bindings: SqlValue[] } {
  const { names, others } = splitNameWords(predicate, search);
  if (!names.length) return compileWordsPredicate(predicate, search, alias);
  // Each name matches as text or through its people's mail; the other words
  // still match as text, together.
  const parts = [
    ...(others.length
      ? [
          compileWordsPredicate(
            { ...predicate, value: others.join(" ") },
            search,
            alias,
          ),
        ]
      : []),
    ...names.map((name) => {
      const words = compileWordsPredicate(
        { ...predicate, value: name },
        search,
        alias,
      );
      const people = contactNameMessages(name, search);
      return {
        sql: `(${words.sql} OR (${alias}.account_id, ${alias}.message_id) IN (${people.sql}))`,
        bindings: [...words.bindings, ...people.bindings],
      };
    }),
  ];
  return {
    sql: `(${parts.map((part) => part.sql).join(" AND ")})`,
    bindings: parts.flatMap((part) => part.bindings),
  };
}

function compileWordsPredicate(
  predicate: Extract<MailPredicate, { kind: "text" }>,
  search: SearchSupport,
  alias: string,
): { sql: string; bindings: SqlValue[] } {
  const unindexed = compileUnindexedText(predicate, alias);
  if (!search.fts5) return unindexed;
  const match = textMatchQuery(predicate);
  if (!match) return { sql: "0=1", bindings: [] };
  // The MATCH subquery does not depend on the row, so SQLite builds its key
  // set once per statement and probes it for each candidate message; the
  // unindexed check only reads the keys' primary-key index.
  const indexed = `(${alias}.account_id, ${alias}.message_id) IN (
      SELECT k.account_id, k.message_id FROM message_fts_keys k
      WHERE k.fts_rowid IN (SELECT rowid FROM message_fts WHERE message_fts MATCH ?)
    )`;
  if (search.complete) return { sql: indexed, bindings: [match] };
  return {
    sql: `(${indexed}
      OR (
        NOT EXISTS (
          SELECT 1 FROM message_fts_keys k
          WHERE k.account_id = ${alias}.account_id AND k.message_id = ${alias}.message_id
        )
        AND ${unindexed.sql}
      ))`,
    bindings: [match, ...unindexed.bindings],
  };
}

function compileUnindexedText(
  predicate: Extract<MailPredicate, { kind: "text" }>,
  alias: string,
): { sql: string; bindings: SqlValue[] } {
  const words = predicate.value.split(/\s+/).filter(Boolean);
  const terms =
    predicate.match === "phrase" || words.length === 0
      ? [predicate.value]
      : words;
  const columns = {
    subject: [`${alias}.subject LIKE ? ESCAPE '\\'`],
    body: [],
    any: [
      `${alias}.subject LIKE ? ESCAPE '\\'`,
      `${alias}.preview LIKE ? ESCAPE '\\'`,
      `${alias}.from_address LIKE ? ESCAPE '\\'`,
    ],
  }[predicate.field];
  if (columns.length === 0) return { sql: "0=1", bindings: [] };
  return {
    sql: `(${terms.map(() => `(${columns.join(" OR ")})`).join(" AND ")})`,
    bindings: terms.flatMap((term) =>
      columns.map(() => `%${escapeLike(term)}%`),
    ),
  };
}

// A typed search read here stands for its local part, which is spliced in.
function topLevelClauses(predicate: MailPredicate): MailPredicate[] {
  if (predicate.kind === "search") return searchClauses(predicate);
  if (predicate.kind !== "all") return [predicate];
  return predicate.predicates.flatMap((clause) =>
    clause.kind === "search" ? searchClauses(clause) : [clause],
  );
}

function searchClauses(
  search: Extract<MailPredicate, { kind: "search" }>,
): MailPredicate[] {
  const local = topLevelClauses(search.local);
  return search.accountIds
    ? [{ kind: "account", ids: search.accountIds }, ...local]
    : local;
}

function compileMailboxPredicate(
  mailbox: Extract<MailPredicate, { kind: "mailbox" }>["mailbox"],
  alias: string,
): { sql: string; bindings: SqlValue[] } {
  switch (mailbox) {
    case "inbox":
      return { sql: `${alias}.in_inbox = 1`, bindings: [] };
    case "sent":
      return { sql: `${alias}.in_sent = 1`, bindings: [] };
    case "drafts":
      return { sql: `${alias}.in_draft = 1`, bindings: [] };
    case "trash":
      return { sql: `${alias}.in_trash = 1`, bindings: [] };
    case "spam":
      return { sql: `${alias}.in_spam = 1`, bindings: [] };
    case "starred":
      return { sql: `${alias}.starred = 1`, bindings: [] };
    case "archive":
      return {
        sql: `(${alias}.in_inbox = 0 AND ${alias}.in_trash = 0 AND ${alias}.in_spam = 0)`,
        bindings: [],
      };
    case "all":
      return {
        sql: `(${alias}.in_trash = 0 AND ${alias}.in_spam = 0)`,
        bindings: [],
      };
    case "snoozed":
      return {
        sql: `IFNULL(${alias}.snoozed_until_ms, 0) > ?`,
        bindings: [Date.now()],
      };
  }
}

function textMatchQuery(
  predicate: Extract<MailPredicate, { kind: "text" }>,
): string | null {
  const query = searchMatchQuery(predicate.value, predicate.match);
  if (!query) return null;
  return predicate.field === "any" ? query : `${predicate.field} : (${query})`;
}

function escapeLike(value: string): string {
  return value
    .replaceAll("\\", "\\\\")
    .replaceAll("%", "\\%")
    .replaceAll("_", "\\_");
}
