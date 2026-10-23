type Row = Record<string, unknown>;
type Where = Record<string, unknown>;

/**
 * The subset of `prisma.snoozedThread` the snooze scheduler uses, over an
 * in-memory table. Each call does its work when called, so an array handed to
 * `$transaction` runs in order, as Postgres would run it.
 */
export function createInMemorySnoozedThreads(rows: Row[]) {
  let nextId = 0;
  const findByMutation = (where: Where) => {
    const key = where.emailAccountId_clientMutationId as Where | undefined;
    if (key) {
      return (
        rows.find(
          (row) =>
            row.emailAccountId === key.emailAccountId &&
            row.clientMutationId === key.clientMutationId,
        ) ?? null
      );
    }
    return rows.find((row) => matches(row, where)) ?? null;
  };
  return {
    findUnique: async ({ where }: { where: Where }) => {
      const row = findByMutation(where);
      return row ? { ...row } : null;
    },
    findUniqueOrThrow: async ({ where }: { where: Where }) => {
      const row = findByMutation(where);
      if (!row) throw new Error("SnoozedThread not found");
      return { ...row };
    },
    findMany: async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)).map((row) => ({ ...row })),
    count: async ({ where }: { where: Where }) =>
      rows.filter((row) => matches(row, where)).length,
    create: async ({ data }: { data: Row }) => {
      if (
        data.clientMutationId != null &&
        rows.some(
          (row) =>
            row.emailAccountId === data.emailAccountId &&
            row.clientMutationId === data.clientMutationId,
        )
      ) {
        throw new Error("Unique constraint failed");
      }
      const row = {
        id: `snooze-${++nextId}`,
        status: "PENDING",
        clientMutationId: null,
        ...data,
        updatedAt: new Date(),
      };
      rows.push(row);
      return { ...row };
    },
    updateMany: async ({ where, data }: { where: Where; data: Row }) => {
      const matched = rows.filter((row) => matches(row, where));
      for (const row of matched) {
        Object.assign(row, { updatedAt: new Date() }, data);
      }
      return { count: matched.length };
    },
  };
}

function matches(row: Row, where: Where): boolean {
  return Object.entries(where).every(([field, condition]) => {
    if (field === "OR") {
      return (condition as Where[]).some((branch) => matches(row, branch));
    }
    return fieldMatches(row[field], condition);
  });
}

function fieldMatches(value: unknown, condition: unknown): boolean {
  if (
    condition === null ||
    typeof condition !== "object" ||
    condition instanceof Date
  ) {
    return sameValue(value, condition);
  }
  const operators = condition as Record<string, unknown>;
  return Object.entries(operators).every(([operator, operand]) => {
    switch (operator) {
      case "in":
        return (operand as unknown[]).some((item) => sameValue(value, item));
      case "not":
        return !fieldMatches(value, operand);
      case "lte":
        return value instanceof Date && value <= (operand as Date);
      default:
        throw new Error(`Unsupported filter: ${operator}`);
    }
  });
}

function sameValue(value: unknown, expected: unknown) {
  if (value instanceof Date && expected instanceof Date) {
    return value.getTime() === expected.getTime();
  }
  return (value ?? null) === (expected ?? null);
}
