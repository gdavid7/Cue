/**
 * A parsed search-box query. Gmail's syntax is the reference: implicit AND
 * between terms, `OR` and `{a b}` alternatives (OR binds tighter than the
 * implicit AND, as in Gmail), `-term` and `NOT term` negation, parentheses,
 * quoted phrases, and `operator:value`. The KQL comparisons Cue's Outlook
 * search form writes (`size>1MB`, `received>=2024-01-31`) parse the same way.
 */
export type SearchNode =
  | { kind: "and"; children: SearchNode[] }
  | { kind: "or"; children: SearchNode[] }
  | { kind: "not"; child: SearchNode }
  | {
      kind: "text";
      value: string;
      /** A quoted phrase, or a `+word` Gmail matches exactly. */
      exact: boolean;
    }
  | {
      kind: "operator";
      /** Lowercased, e.g. `from`, `newer_than`, `size`. */
      name: string;
      comparator: SearchComparator;
      value: string;
      quoted: boolean;
    }
  /** Gmail's `a AROUND 5 b` proximity search. */
  | { kind: "around"; text: string };

export type SearchComparator = ":" | "=" | ">" | ">=" | "<" | "<=";

/**
 * Operators Gmail or Outlook understand. Any other `word:value` is plain
 * text, as it is to Gmail, so a pasted `re:` or URL still searches.
 */
const OPERATORS = new Set([
  "from",
  "to",
  "cc",
  "bcc",
  "subject",
  "label",
  "in",
  "is",
  "has",
  "filename",
  "list",
  "deliveredto",
  "category",
  "size",
  "larger",
  "smaller",
  "after",
  "before",
  "older",
  "newer",
  "older_than",
  "newer_than",
  "rfc822msgid",
  // Outlook / KQL
  "hasattachment",
  "hasattachments",
  "received",
  "sent",
  "folder",
  "body",
  "participants",
  "importance",
  "attachment",
  "attachments",
  "kind",
]);

const MAX_DEPTH = 32;

export function parseSearchQuery(query: string): SearchNode {
  const parser = new Parser(query);
  return parser.parse();
}

class Parser {
  private at = 0;
  private depth = 0;
  private readonly input: string;

  constructor(input: string) {
    this.input = input;
  }

  parse(): SearchNode {
    const parts = [this.sequence()];
    // A stray closing bracket is noise, as it is to Gmail.
    while (this.at < this.input.length) {
      this.at += 1;
      parts.push(this.sequence());
    }
    return and(parts);
  }

  /** Terms up to a closing bracket or the end, joined by implicit AND. */
  private sequence(): SearchNode {
    const items: SearchNode[] = [];
    while (true) {
      this.skipSpace();
      const char = this.peek();
      // A group's caller consumes its closing bracket; parse() skips a stray
      // one.
      if (char === null || char === ")" || char === "}") break;
      if (this.keyword("AND")) continue;
      if (this.keyword("OR")) {
        const left = items.pop();
        this.skipSpace();
        const right = this.unary();
        if (!left) {
          if (right) items.push(right);
          continue;
        }
        if (!right) {
          items.push(left);
          continue;
        }
        items.push(or([left, right]));
        continue;
      }
      if (this.keyword("AROUND")) {
        const left = items.pop();
        this.skipSpace();
        const distance = this.input.slice(this.at).match(/^\d+/)?.[0];
        if (distance) this.at += distance.length;
        this.skipSpace();
        const start = this.at;
        const right = this.unary();
        if (!left || !right) {
          if (left) items.push(left);
          if (right) items.push(right);
          continue;
        }
        items.push({
          kind: "around",
          text: `${nodeText(left)} AROUND ${distance ?? ""} ${this.input
            .slice(start, this.at)
            .trim()}`.replace(/\s+/g, " "),
        });
        continue;
      }
      const item = this.unary();
      if (item) items.push(item);
    }
    return and(items);
  }

  private unary(): SearchNode | null {
    const char = this.peek();
    if (char === "-" && this.isTermStart(this.at + 1)) {
      this.at += 1;
      const child = this.unary();
      return child ? { kind: "not", child } : null;
    }
    if (this.keyword("NOT")) {
      this.skipSpace();
      const child = this.unary();
      return child ? { kind: "not", child } : null;
    }
    if (char === "+" && this.isTermStart(this.at + 1)) {
      this.at += 1;
      const word = this.word();
      return word ? { kind: "text", value: word, exact: true } : null;
    }
    return this.primary();
  }

  private primary(): SearchNode | null {
    const char = this.peek();
    if (char === null) return null;
    if (char === "(" || char === "{") return this.group();
    if (char === '"') {
      const phrase = this.quoted();
      return phrase ? { kind: "text", value: phrase, exact: true } : null;
    }
    // Left for the enclosing sequence to end on.
    if (char === ")" || char === "}") return null;
    const operator = this.input
      .slice(this.at)
      .match(/^([a-z_]+)(>=|<=|:|=|>|<)/i);
    if (operator && OPERATORS.has(operator[1].toLowerCase())) {
      const name = operator[1].toLowerCase();
      const comparator = operator[2] as SearchComparator;
      const valueStart = this.at + operator[0].length;
      const next = this.input[valueStart];
      if (next === "(" || next === "{") {
        this.at = valueStart;
        const group = this.group();
        return group ? applyOperator(group, name, comparator) : null;
      }
      if (next === '"') {
        this.at = valueStart;
        const value = this.quoted();
        return value
          ? { kind: "operator", name, comparator, value, quoted: true }
          : null;
      }
      if (next !== undefined && !/[\s)}]/.test(next)) {
        this.at = valueStart;
        const value = this.word();
        return { kind: "operator", name, comparator, value, quoted: false };
      }
    }
    const word = this.word();
    return word ? { kind: "text", value: word, exact: false } : null;
  }

  private group(): SearchNode | null {
    const open = this.input[this.at];
    const close = open === "{" ? "}" : ")";
    this.at += 1;
    // Past this depth an opening bracket is skipped, so nesting can't
    // exhaust the stack.
    if (this.depth >= MAX_DEPTH) return null;
    this.depth += 1;
    const inner = this.sequence();
    this.depth -= 1;
    if (this.peek() === close) this.at += 1;
    if (isEmpty(inner)) return null;
    // {a b} lists alternatives.
    if (open === "{" && inner.kind === "and") return or(inner.children);
    return inner;
  }

  private quoted(): string {
    const start = this.at + 1;
    const end = this.input.indexOf('"', start);
    const stop = end === -1 ? this.input.length : end;
    this.at = end === -1 ? this.input.length : end + 1;
    return this.input.slice(start, stop).replace(/\s+/g, " ").trim();
  }

  /** A bare word: up to whitespace, a bracket or a quote. */
  private word(): string {
    const match = this.input.slice(this.at).match(/^[^\s(){}"]+/);
    const word = match?.[0] ?? "";
    this.at += word.length || 1;
    return word;
  }

  /** An uppercase keyword standing on its own, consumed when present. */
  private keyword(word: "AND" | "OR" | "NOT" | "AROUND"): boolean {
    if (!this.input.startsWith(word, this.at)) return false;
    const after = this.input[this.at + word.length];
    if (after !== undefined && !/[\s({"]/.test(after)) return false;
    // NOT only negates when something follows it.
    if (word === "NOT" && !this.input.slice(this.at + word.length).trim())
      return false;
    this.at += word.length;
    return true;
  }

  private isTermStart(index: number) {
    const char = this.input[index];
    return char !== undefined && !/[\s)}]/.test(char);
  }

  private peek(): string | null {
    return this.at < this.input.length ? this.input[this.at] : null;
  }

  private skipSpace() {
    while (this.at < this.input.length && /\s/.test(this.input[this.at]))
      this.at += 1;
  }
}

/** `subject:(a b)` and `from:{a b}` apply the operator to each term inside. */
function applyOperator(
  node: SearchNode,
  name: string,
  comparator: SearchComparator,
): SearchNode {
  switch (node.kind) {
    case "text":
      return {
        kind: "operator",
        name,
        comparator,
        value: node.value,
        quoted: node.exact,
      };
    case "and":
    case "or":
      return {
        kind: node.kind,
        children: node.children.map((child) =>
          applyOperator(child, name, comparator),
        ),
      };
    case "not":
      return {
        kind: "not",
        child: applyOperator(node.child, name, comparator),
      };
    default:
      return node;
  }
}

function and(children: SearchNode[]): SearchNode {
  const flat = children.flatMap((child) =>
    child.kind === "and" ? child.children : [child],
  );
  return flat.length === 1 ? flat[0] : { kind: "and", children: flat };
}

function or(children: SearchNode[]): SearchNode {
  const flat = children.flatMap((child) =>
    child.kind === "or" ? child.children : [child],
  );
  return flat.length === 1 ? flat[0] : { kind: "or", children: flat };
}

function isEmpty(node: SearchNode) {
  return node.kind === "and" && node.children.length === 0;
}

function nodeText(node: SearchNode): string {
  switch (node.kind) {
    case "text":
      return node.exact ? `"${node.value}"` : node.value;
    case "operator":
      return `${node.name}${node.comparator}${node.quoted ? `"${node.value}"` : node.value}`;
    case "around":
      return node.text;
    case "not":
      return `-${nodeText(node.child)}`;
    case "and":
      return `(${node.children.map(nodeText).join(" ")})`;
    case "or":
      return `{${node.children.map(nodeText).join(" ")}}`;
  }
}
