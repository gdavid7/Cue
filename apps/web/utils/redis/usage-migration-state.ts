/**
 * A usage migration's done record. Upstash hands a stored JSON value back as
 * an object, so a record arrives as an object or a string, and both are read.
 */
export function readUsageMigrationRecord(
  raw: unknown,
): Record<string, unknown> | null {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return null;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * A weekly cost migration's record as cost by day. Before RD-3 it was keyed
 * by the legacy cost key, which named the address (`keyedByAddress`). Those
 * records are summed by day so they can be rewritten without it.
 */
export function readWeeklyCostsByDay(
  raw: unknown,
): { costsByDay: Map<string, number>; keyedByAddress: boolean } | null {
  const record = readUsageMigrationRecord(raw);
  if (!record) return null;

  const byDay = asRecord(record.weeklyCostsByDay);
  if (byDay) {
    const costsByDay = new Map<string, number>();
    for (const [day, value] of Object.entries(byDay)) {
      const cost = toNumber(value);
      if (cost > 0) costsByDay.set(day, cost);
    }
    return { costsByDay, keyedByAddress: false };
  }

  const byKey = asRecord(record.weeklyCosts);
  if (!byKey) return null;
  const costsByDay = new Map<string, number>();
  for (const [key, value] of Object.entries(byKey)) {
    const day = /:(\d{4}-\d{2}-\d{2})$/.exec(key)?.[1];
    const cost = toNumber(value);
    if (day && cost > 0) costsByDay.set(day, (costsByDay.get(day) ?? 0) + cost);
  }
  return { costsByDay, keyedByAddress: true };
}

function asRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function toNumber(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value === "string") return Number.parseFloat(value) || 0;
  return 0;
}
