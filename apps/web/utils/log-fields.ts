// Axiom turns every flattened key path of an event into a dataset column, and
// the dataset rejects events once it holds 256. One event may add at most this
// many paths; the rest travel as one JSON string.
export const MAX_LOG_FIELD_PATHS = 40;
export const LOG_FIELDS_OVERFLOW_KEY = "fieldsOverflow";
const MAX_OVERFLOW_LENGTH = 8000;
const MAX_DEPTH = 10;

type LogFields = Record<string, unknown>;

/**
 * Keeps an event within MAX_LOG_FIELD_PATHS flattened key paths. Shallow paths
 * are kept first, so `scope`, the message context and an error's name, message
 * and stack outlast deeply nested detail; the paths that do not fit are moved,
 * still nested, into a single JSON string under LOG_FIELDS_OVERFLOW_KEY.
 * Arrays are one path, as Axiom stores them in one column.
 */
export function capLogFields(fields: LogFields): LogFields {
  const leaves = collectLeaves(fields, []);
  if (leaves.length <= MAX_LOG_FIELD_PATHS) return fields;

  const ordered = leaves
    .map((leaf, order) => ({ ...leaf, order }))
    .sort((a, b) => a.path.length - b.path.length || a.order - b.order);
  const keepCount = MAX_LOG_FIELD_PATHS - 1;
  const kept = ordered.slice(0, keepCount).sort((a, b) => a.order - b.order);
  const overflow = ordered.slice(keepCount).sort((a, b) => a.order - b.order);

  const capped: LogFields = {};
  for (const leaf of kept) setPath(capped, leaf.path, leaf.value);
  const overflowFields: LogFields = {};
  for (const leaf of overflow) setPath(overflowFields, leaf.path, leaf.value);
  capped[LOG_FIELDS_OVERFLOW_KEY] = truncate(safeStringify(overflowFields));
  return capped;
}

function collectLeaves(
  value: LogFields,
  path: string[],
): { path: string[]; value: unknown }[] {
  const entries = Object.entries(value);
  if (entries.length === 0 && path.length > 0) return [{ path, value }];
  return entries.flatMap(([key, child]) =>
    // The depth bound also stops a self-referencing object.
    isPlainObject(child) && path.length < MAX_DEPTH
      ? collectLeaves(child, [...path, key])
      : [{ path: [...path, key], value: child }],
  );
}

function setPath(target: LogFields, path: string[], value: unknown) {
  let node = target;
  for (const key of path.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {};
    node = node[key] as LogFields;
  }
  node[path[path.length - 1]] = value;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value);
  } catch {
    return '"[unserializable]"';
  }
}

function truncate(text: string) {
  return text.length <= MAX_OVERFLOW_LENGTH
    ? text
    : `${text.slice(0, MAX_OVERFLOW_LENGTH)}…`;
}

function isPlainObject(value: unknown): value is LogFields {
  if (typeof value !== "object" || value === null) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}
